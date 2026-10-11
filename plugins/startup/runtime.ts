/**
 * Start voice on startup.
 *
 * Better Grok Bot hands the plugin the app's client (`ctx.app.onClient`, fed by the `bgb-client` core
 * hook) and, on every chat view render, a patch hands it the composer's own voice-call button handler
 * for the bot on screen (`offerVoiceCall`). Once per app launch, when a bot is chosen, the plugin waits
 * for sign-in, the server roster, and the chat view, focuses the bot the way a notification click does
 * (`desktopWindow.ingestFocusAgent`), then presses that bot's voice-call handler.
 *
 * Opening Grok Bot at login is Better Grok Bot's own "Open Grok Bot at login" setting.
 */
import type { ComponentFactory, PluginContext } from "@better-grok-bot/sdk";

const VOICE_BOT_KEY = "voiceBot";
const VOICE_ROW_LABEL = "Start voice on startup";
const OFF_VALUE = "";
/** Survives renderer reloads in the same window, so a reload never starts a second call. */
const LAUNCH_MARKER = "bgb:startup:launch-seen";
/** Held for the life of the first window; later windows fail to get it and never start a call. */
const PRIMARY_WINDOW_LOCK = "bgb:startup:primary-window";
/** How long the app gets to sign in, load the roster, and show the chat before voice start gives up. */
const READY_TIMEOUT_MS = 180_000;
const POLL_MS = 1_000;
/** Pause between focus attempts while the chat view still shows another bot. */
const REFOCUS_MS = 5_000;

// ---------------------------------------------------------------------------
// The app's client, as far as this plugin uses it
// ---------------------------------------------------------------------------

interface Snapshots<T> {
	get(): T;
	subscribe(listener: () => void): () => void;
}

interface RosterAgent {
	id: string;
	name: string;
	isGroup?: boolean;
	isHiddenFromSidebar?: boolean;
}

interface RosterSnapshot {
	loadState?: string;
	isShowingRestoredRoster?: boolean;
	agents: { rows: readonly RosterAgent[] };
}

interface SandClient {
	auth: { snapshots: Snapshots<{ status?: { kind?: string } } | undefined> };
	roster: { snapshots: Snapshots<RosterSnapshot> };
	voiceCall: { snapshots: Snapshots<{ phase?: string } | undefined> };
	desktopWindow: { ingestFocusAgent(request: { id: string }): void };
}

/** The client is checked once where it is handed over; everything after trusts {@link SandClient}. */
function isSandClient(value: unknown): value is SandClient {
	if (typeof value !== "object" || value === null) return false;
	const parts = value as Partial<Record<keyof SandClient, { snapshots?: Partial<Snapshots<unknown>>; ingestFocusAgent?: unknown }>>;
	const stores = [parts.auth?.snapshots, parts.roster?.snapshots, parts.voiceCall?.snapshots];
	return (
		stores.every((store) => typeof store?.get === "function" && typeof store.subscribe === "function") &&
		typeof parts.desktopWindow?.ingestFocusAgent === "function"
	);
}

interface Bot {
	id: string;
	name: string;
}

/** Bots as the sidebar lists them: every row except group chats and bots hidden from the sidebar. `null` before the roster has rows. */
function botsOf(snapshot: RosterSnapshot | undefined): readonly Bot[] | null {
	const rows = snapshot?.agents?.rows;
	if (!Array.isArray(rows)) return null;
	return rows
		.filter((row) => row.isGroup !== true && row.isHiddenFromSidebar !== true)
		.map((row) => ({ id: row.id, name: row.name?.trim() || row.id }));
}

/** The roster came from the server this launch (not the copy restored from disk). */
function isRosterLoaded(snapshot: RosterSnapshot | undefined): boolean {
	return snapshot?.loadState === "ready" && snapshot.isShowingRestoredRoster !== true;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function createStartup(ctx: PluginContext) {
	// --- stored choice -------------------------------------------------------

	const readVoiceBot = (): string | null => {
		const value = ctx.storage.get<unknown>(VOICE_BOT_KEY, null);
		return typeof value === "string" && value !== "" ? value : null;
	};
	const subscribeVoiceBot = (listener: () => void): (() => void) => ctx.storage.subscribe(VOICE_BOT_KEY, listener);

	// --- client --------------------------------------------------------------

	let client: SandClient | null = null;
	let rejectedClient: unknown = null;
	const clientListeners = new Set<() => void>();
	let unsubscribeClient: (() => void) | null = null;
	/** Store callbacks and patched renders only queue a step; the step itself runs outside them. */
	const scheduleVoiceStart = (): void => {
		if (pending !== null) window.setTimeout(advanceVoiceStart, 0);
	};

	/**
	 * Every new app client (the first, and a replacement after the app remounts its provider): drops the
	 * old client's snapshot subscriptions, follows the new client's, and tells the roster store.
	 */
	const attachClient = (candidate: unknown): void => {
		if (candidate === client || candidate === rejectedClient) return;
		if (!isSandClient(candidate)) {
			rejectedClient = candidate;
			ctx.log.warn("app client does not have the expected shape; startup voice and the bot list are unavailable");
			return;
		}
		unsubscribeClient?.();
		client = candidate;
		const unsubscribers = [
			candidate.auth.snapshots.subscribe(scheduleVoiceStart),
			candidate.roster.snapshots.subscribe(scheduleVoiceStart),
			candidate.voiceCall.snapshots.subscribe(scheduleVoiceStart),
		];
		unsubscribeClient = () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
		for (const listener of [...clientListeners]) listener();
		scheduleVoiceStart();
	};

	/** Roster store for the Settings dropdown: follows the client, then its roster snapshots. */
	const subscribeRoster = (listener: () => void): (() => void) => {
		let unsubscribeSnapshots: (() => void) | null = null;
		const follow = (): void => {
			unsubscribeSnapshots?.();
			unsubscribeSnapshots = client?.roster.snapshots.subscribe(listener) ?? null;
			listener();
		};
		clientListeners.add(follow);
		unsubscribeSnapshots = client?.roster.snapshots.subscribe(listener) ?? null;
		return () => {
			clientListeners.delete(follow);
			unsubscribeSnapshots?.();
		};
	};
	const readRoster = (): RosterSnapshot | undefined => client?.roster.snapshots.get();

	// --- voice on startup ----------------------------------------------------

	interface VoiceCallOffer {
		agentId: string | null;
		start: (() => void) | undefined;
	}

	interface PendingVoiceStart {
		botId: string;
		deadline: number;
		/** `window.setInterval` handle for the poll that catches what no snapshot announces (the deadline). */
		timer: number;
		lastFocusAt: number;
		lastWaitingFor: string;
	}

	let offer: VoiceCallOffer | null = null;
	let pending: PendingVoiceStart | null = null;

	const finishVoiceStart = (): void => {
		if (pending === null) return;
		clearInterval(pending.timer);
		pending = null;
	};

	const waitFor = (state: PendingVoiceStart, what: string): void => {
		if (state.lastWaitingFor === what) return;
		state.lastWaitingFor = what;
		ctx.log.info(`voice on startup: waiting for ${what}`);
	};

	function advanceVoiceStart(): void {
		const state = pending;
		if (state === null) return;
		if (Date.now() > state.deadline) {
			ctx.log.warn(
				`voice on startup: gave up after ${READY_TIMEOUT_MS / 1000}s waiting for ${state.lastWaitingFor || "the app"}`,
			);
			finishVoiceStart();
			return;
		}
		if (readVoiceBot() !== state.botId) {
			ctx.log.info("voice on startup: choice changed before the app was ready; not starting a call");
			finishVoiceStart();
			return;
		}
		if (client === null) return waitFor(state, "the app client");
		if (client.auth.snapshots.get()?.status?.kind !== "logged-in") return waitFor(state, "sign-in");
		const roster = client.roster.snapshots.get();
		if (!isRosterLoaded(roster)) return waitFor(state, "the bot list");
		// Same list as the dropdown, so a choice the row shows as Off never starts a call.
		if (!botsOf(roster)?.some((bot) => bot.id === state.botId)) {
			ctx.log.info(`voice on startup: bot ${state.botId} is no longer in the bot list; not starting a call`);
			finishVoiceStart();
			return;
		}
		const phase = client.voiceCall.snapshots.get()?.phase;
		if (phase !== undefined && phase !== "idle" && phase !== "ended") {
			ctx.log.info(`voice on startup: a call is already ${phase}; not starting another`);
			finishVoiceStart();
			return;
		}
		// The chat view renders the composer and offers its voice-call handler; until it has, there is
		// no window shell listening for focus requests either.
		if (offer === null) return waitFor(state, "the chat view");
		if (offer.agentId !== state.botId) {
			const now = Date.now();
			if (now - state.lastFocusAt >= REFOCUS_MS) {
				state.lastFocusAt = now;
				ctx.log.info(`voice on startup: opening bot ${state.botId}`);
				client.desktopWindow.ingestFocusAgent({ id: state.botId });
			}
			return waitFor(state, "the bot's chat");
		}
		const start = offer.start;
		if (start === undefined) return waitFor(state, "the bot's voice call button");
		const botId = state.botId;
		finishVoiceStart();
		ctx.log.info(`voice on startup: starting a voice call with bot ${botId}`);
		try {
			start();
		} catch (error) {
			ctx.log.error("voice on startup: the app's voice call button handler threw", error);
		}
	}

	/**
	 * Called from the chat view's render with the bot on screen and its voice-call button handler
	 * (`undefined` while the bot can't be called or a call is up). Returns `undefined` so the app keeps
	 * its own handler.
	 */
	const offerVoiceCall = (agentId: unknown, start: unknown): undefined => {
		const next: VoiceCallOffer = {
			agentId: typeof agentId === "string" ? agentId : null,
			start: typeof start === "function" ? () => void Reflect.apply(start, undefined, []) : undefined,
		};
		const changed = offer === null || offer.agentId !== next.agentId || (offer.start === undefined) !== (next.start === undefined);
		offer = next;
		if (changed) scheduleVoiceStart();
		return undefined;
	};

	const beginVoiceStart = (): void => {
		const botId = readVoiceBot();
		if (botId === null) return;
		ctx.log.info(`voice on startup: will start a voice call with bot ${botId} once the app is ready`);
		pending = {
			botId,
			deadline: Date.now() + READY_TIMEOUT_MS,
			timer: window.setInterval(advanceVoiceStart, POLL_MS),
			lastFocusAt: Number.NEGATIVE_INFINITY,
			lastWaitingFor: "",
		};
		advanceVoiceStart();
	};

	/** Once per app launch: the first window that loads, and never again after a reload of it. */
	const claimLaunch = (): void => {
		let reloaded = false;
		try {
			reloaded = sessionStorage.getItem(LAUNCH_MARKER) !== null;
			sessionStorage.setItem(LAUNCH_MARKER, String(Date.now()));
		} catch (error) {
			ctx.log.warn("voice on startup: sessionStorage unavailable; not starting a call", error);
			return;
		}
		const locks = typeof navigator === "object" ? navigator.locks : undefined;
		if (locks === undefined) {
			ctx.log.warn("voice on startup: Web Locks unavailable; not starting a call");
			return;
		}
		// Every window competes for the lock; the first keeps it until it unloads, so a window opened
		// later finds it taken. A reload of the first window re-takes it but is caught by the marker.
		void locks
			.request(PRIMARY_WINDOW_LOCK, { ifAvailable: true }, (lock) => {
				if (lock === null) {
					ctx.log.info("voice on startup: not the first window; skipping");
					return undefined;
				}
				if (reloaded) ctx.log.info("voice on startup: window reloaded; skipping");
				else beginVoiceStart();
				return new Promise<never>(() => {});
			})
			.catch((error: unknown) => ctx.log.warn("voice on startup: window election failed; not starting a call", error));
	};

	ctx.app.onClient(attachClient);
	claimLaunch();

	// --- settings ------------------------------------------------------------

	const SettingsRows: ComponentFactory = (deps) => {
		const { React, jsx, Row, Select } = deps;
		if (Row === undefined || Select === undefined) {
			throw new TypeError("SettingsRows needs the settings Row and Select components");
		}

		const onVoiceBotChange = (value: unknown): void => {
			if (typeof value !== "string") return;
			ctx.storage.set(VOICE_BOT_KEY, value === OFF_VALUE ? null : value);
		};

		return function StartVoiceRow() {
			const roster = React.useSyncExternalStore(subscribeRoster, readRoster);
			const stored = React.useSyncExternalStore(subscribeVoiceBot, readVoiceBot);
			const bots = React.useMemo(() => botsOf(roster), [roster]);
			const loaded = bots !== null && isRosterLoaded(roster);
			const options = React.useMemo(() => {
				const list = [{ value: OFF_VALUE, label: "Off" }, ...(bots ?? []).map((bot) => ({ value: bot.id, label: bot.name }))];
				// Until the bot list arrives, keep showing the stored choice rather than flipping to Off.
				if (stored !== null && !loaded && !list.some((option) => option.value === stored)) {
					list.push({ value: stored, label: "Loading bots…" });
				}
				return list;
			}, [bots, stored, loaded]);
			const value = stored !== null && options.some((option) => option.value === stored) ? stored : OFF_VALUE;
			return jsx(Row, {
				label: VOICE_ROW_LABEL,
				description: "Open a voice chat with this bot when Grok Bot starts.",
				variant: "card",
				children: jsx(Select, {
					"aria-label": VOICE_ROW_LABEL,
					onValueChange: onVoiceBotChange,
					options,
					placement: "bottom-end",
					size: "lg",
					value,
					variant: "ghost",
				}),
			});
		};
	};

	return { offerVoiceCall, SettingsRows };
}

globalThis.BetterGrokBot?.define("startup", createStartup);

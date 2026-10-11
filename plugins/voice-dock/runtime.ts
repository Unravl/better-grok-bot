/**
 * The voice call docked in the sidebar footer as a call card.
 *
 * The dock renders the app's own voice-call popover component (captured by the `sidebar-dock` patch) with the
 * same inputs the chat view gives it: the call from `client.voiceCall.snapshots`, the bot in the call from the
 * roster, and `client.voiceCall.toggleMute` / `hangUp` / `dismissFailure`. Every control (call settings,
 * transcript, mute, hang up, failure dismiss) is the app's, so it behaves as before. The popover shows neither
 * the bot's name nor the call's status, so the dock renders them next to it: the name, and a status line with a
 * coloured dot, the phase and, once connected, the call timer (`client.voiceCall.elapsedMs`, the store behind
 * the app's own call chip). styles.css lays both out as one card. The sidebar is mounted for every bot, so the
 * dock stays while the user switches bots; while it is mounted the chat view's floating popover is hidden.
 */
import type { ComponentFactory, PluginContext } from "@better-grok-bot/sdk";

interface Snapshots<T> {
	get(): T;
	subscribe(listener: () => void): () => void;
}

export interface VoiceCall {
	phase?: string;
	agentId?: string | null;
	isMuted?: boolean;
}

export interface AgentRow {
	id?: unknown;
	name?: unknown;
}

interface VoiceClient {
	voiceCall: {
		snapshots: Snapshots<VoiceCall | undefined | null>;
		/** Milliseconds since the call started, set once a second while it is underway. */
		elapsedMs?: unknown;
		toggleMute: () => void;
		hangUp: () => unknown;
		dismissFailure: () => void;
	};
	roster?: { snapshots?: Snapshots<{ agents?: { rows?: readonly AgentRow[] } } | undefined> };
}

/** An app store: `get` plus `subscribe`. */
export function isStore(value: unknown): value is Snapshots<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"get" in value &&
		typeof value.get === "function" &&
		"subscribe" in value &&
		typeof value.subscribe === "function"
	);
}

/** The client parts the dock needs, or undefined when the app's client has another shape. */
export function voiceClient(client: unknown): VoiceClient | undefined {
	if (typeof client !== "object" || client === null || !("voiceCall" in client)) return undefined;
	const { voiceCall } = client;
	if (typeof voiceCall !== "object" || voiceCall === null || !("snapshots" in voiceCall) || !isStore(voiceCall.snapshots)) return undefined;
	for (const name of ["toggleMute", "hangUp", "dismissFailure"]) if (typeof Reflect.get(voiceCall, name) !== "function") return undefined;
	// Checked above: the call store and the three actions; the optional roster is taken as the app has it.
	const checked = client as VoiceClient;
	return checked;
}

/** A call the popover shows: anything but idle (the app's own rule, minus "is that bot on screen"). */
export function isCallShown(call: VoiceCall | undefined | null): call is VoiceCall {
	return call != null && typeof call.phase === "string" && call.phase !== "idle";
}

export function findAgent(rows: readonly AgentRow[] | undefined, agentId: string | null | undefined): AgentRow | null {
	if (rows === undefined || agentId == null) return null;
	return rows.find((row) => row.id === agentId) ?? null;
}

/** The bot's name as the roster has it (the app's call chip shows the same), or null when it has none. */
export function agentName(agent: AgentRow | null): string | null {
	const name = typeof agent?.name === "string" ? agent.name.trim() : "";
	return name === "" ? null : name;
}

/** `m:ss`, or `h:mm:ss` from an hour on: the app's own call-duration format. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const seconds = String(total % 60).padStart(2, "0");
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	return hours === 0 ? `${minutes}:${seconds}` : `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

export interface CallStatus {
	/** The dot's colour: green while connected, amber while (re)connecting, grey while hanging up. */
	tone: "connected" | "connecting" | "ending";
	label: string;
	/** Whether the call timer follows the label. */
	timed: boolean;
}

/** The status line for a call the dock shows; null for a phase without one (a failed call shows the app's alert). */
export function callStatus(call: VoiceCall): CallStatus | null {
	switch (call.phase) {
		case "connecting":
			return { tone: "connecting", label: "Connecting…", timed: false };
		case "live":
			return { tone: "connected", label: call.isMuted === true ? "Muted" : "Connected", timed: true };
		case "reconnecting":
			return { tone: "connecting", label: "Reconnecting…", timed: false };
		case "ending":
			return { tone: "ending", label: "Ending…", timed: false };
		default:
			return null;
	}
}

const noopUnsubscribe = (): void => {};
const noSubscribe = (): (() => void) => noopUnsubscribe;

function createVoiceDock(ctx: PluginContext) {
	/** Number of mounted docks; the floating popover is hidden while it is above zero. */
	let docks = 0;
	const listeners = new Set<() => void>();
	const setDocks = (next: number): void => {
		docks = next;
		for (const listener of listeners) listener();
	};
	const subscribeDocks = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	const readDocked = (): boolean => docks > 0;

	const subscribeClient = (onChange: () => void): (() => void) => ctx.app.onClient(onChange);
	const readClient = (): unknown => ctx.app.client;

	/** Hook, called from the chat view's render: true while a dock is mounted. */
	const useDocked = (): boolean => {
		const React = ctx.app.React;
		if (React === undefined) return false;
		return React.useSyncExternalStore(subscribeDocks, readDocked);
	};

	const Dock: ComponentFactory = ({ React, jsx, Popover }) => {
		if (Popover === undefined) throw new TypeError("Dock needs the app's voice-call popover component");

		/** ` · 3:12:45`: its own component, so the timer's once-a-second tick re-renders only this text. */
		function CallTimer({ store }: { store: Snapshots<unknown> }): string | null {
			const ms = React.useSyncExternalStore(store.subscribe, store.get);
			return typeof ms === "number" && Number.isFinite(ms) ? ` · ${formatElapsed(ms)}` : null;
		}

		/** The bot's name over the status line; styles.css places it beside the popover's avatar. */
		const identity = (agent: AgentRow | null, call: VoiceCall, timer: Snapshots<unknown> | undefined): unknown => {
			const name = agentName(agent);
			const status = callStatus(call);
			const text = status?.timed === true && timer !== undefined ? [status.label, jsx(CallTimer, { store: timer }, "timer")] : status?.label;
			const statusLine =
				status === null
					? null
					: jsx(
							"span",
							{
								className: "bgb-voice-dock__status",
								"data-tone": status.tone,
								children: [
									jsx("span", { className: "bgb-voice-dock__dot", "aria-hidden": true }, "dot"),
									jsx("span", { className: "bgb-voice-dock__status-text", children: text }, "text"),
								],
							},
							"status",
						);
			const nameLine = name === null ? null : jsx("span", { className: "bgb-voice-dock__name", title: name, children: name }, "name");
			return jsx("div", { className: "bgb-voice-dock__identity", children: [nameLine, statusLine] }, "identity");
		};

		return function VoiceDock() {
			const client = voiceClient(React.useSyncExternalStore(subscribeClient, readClient));
			// Counts as docked from mount, whether or not a call is up, so the chat view never flashes the popover.
			React.useEffect(() => {
				if (client === undefined) return;
				setDocks(docks + 1);
				return () => setDocks(Math.max(0, docks - 1));
			}, [client]);
			const callStore = client?.voiceCall.snapshots;
			const rosterStore = client?.roster?.snapshots;
			const call = React.useSyncExternalStore(callStore?.subscribe ?? noSubscribe, () => callStore?.get());
			const roster = React.useSyncExternalStore(rosterStore?.subscribe ?? noSubscribe, () => rosterStore?.get());
			const handlers = React.useMemo(
				() =>
					client === undefined
						? null
						: {
								onToggleMute: () => client.voiceCall.toggleMute(),
								onHangUp: () => {
									client.voiceCall.hangUp();
								},
								onDismissFailure: () => client.voiceCall.dismissFailure(),
							},
				[client],
			);
			if (client === undefined || handlers === null || !isCallShown(call)) return null;
			const agent = findAgent(roster?.agents?.rows, call.agentId);
			const timer = isStore(client.voiceCall.elapsedMs) ? client.voiceCall.elapsedMs : undefined;
			return jsx("div", {
				className: "bgb-voice-dock",
				// The popover's mute button carries no aria-pressed, so styles.css reads mute from here.
				"data-muted": call.isMuted === true ? "" : undefined,
				children: [
					// A failed call shows only the app's alert (its message and Dismiss).
					call.phase === "failed" ? null : identity(agent, call, timer),
					jsx(Popover, { agent, call, bgbDocked: true, ...handlers }, "popover"),
				],
			});
		};
	};

	return { Dock, useDocked };
}

globalThis.BetterGrokBot?.define("voice-dock", createVoiceDock);

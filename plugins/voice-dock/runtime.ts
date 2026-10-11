/**
 * Voice-call controls docked in the sidebar footer.
 *
 * The dock renders the app's own voice-call popover component (captured by the `sidebar-dock` patch) with the
 * same inputs the chat view gives it: the call from `client.voiceCall.snapshots`, the bot in the call from the
 * roster, and `client.voiceCall.toggleMute` / `hangUp` / `dismissFailure`. Every control (call settings,
 * transcript, mute, hang up, failure dismiss) is the app's, so it behaves as before. The sidebar is mounted for
 * every bot, so the dock stays while the user switches bots; while it is mounted the chat view's floating
 * popover is hidden.
 */
import type { ComponentFactory, PluginContext } from "@better-grok-bot/sdk";

interface Snapshots<T> {
	get(): T;
	subscribe(listener: () => void): () => void;
}

export interface VoiceCall {
	phase?: string;
	agentId?: string | null;
}

interface AgentRow {
	id?: unknown;
}

interface VoiceClient {
	voiceCall: {
		snapshots: Snapshots<VoiceCall | undefined | null>;
		toggleMute: () => void;
		hangUp: () => unknown;
		dismissFailure: () => void;
	};
	roster?: { snapshots?: Snapshots<{ agents?: { rows?: readonly AgentRow[] } } | undefined> };
}

/** The client parts the dock needs, or undefined when the app's client has another shape. */
export function voiceClient(client: unknown): VoiceClient | undefined {
	if (typeof client !== "object" || client === null) return undefined;
	const voiceCall = (client as { voiceCall?: unknown }).voiceCall as Record<string, unknown> | undefined;
	if (typeof voiceCall !== "object" || voiceCall === null) return undefined;
	const snapshots = voiceCall.snapshots as Record<string, unknown> | undefined;
	if (typeof snapshots?.get !== "function" || typeof snapshots.subscribe !== "function") return undefined;
	for (const name of ["toggleMute", "hangUp", "dismissFailure"]) if (typeof voiceCall[name] !== "function") return undefined;
	return client as VoiceClient;
}

/** A call the popover shows: anything but idle (the app's own rule, minus "is that bot on screen"). */
export function isCallShown(call: VoiceCall | undefined | null): call is VoiceCall {
	return call != null && typeof call.phase === "string" && call.phase !== "idle";
}

export function findAgent(rows: readonly AgentRow[] | undefined, agentId: string | null | undefined): AgentRow | null {
	if (rows === undefined || agentId == null) return null;
	return rows.find((row) => row.id === agentId) ?? null;
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
			return jsx("div", {
				className: "bgb-voice-dock",
				children: jsx(Popover, {
					agent: findAgent(roster?.agents?.rows, call.agentId),
					call,
					bgbDocked: true,
					...handlers,
				}),
			});
		};
	};

	return { Dock, useDocked };
}

globalThis.BetterGrokBot?.define("voice-dock", createVoiceDock);

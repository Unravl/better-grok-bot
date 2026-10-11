import type { AgentStatus, BridgeState, PluginLogger, UpdateStatus } from "../sdk/index.ts";
import type { Clock } from "./clock.ts";

/** After this long without an agent connection, the settings section offers "Reload to apply". */
export const DISCONNECT_RELOAD_MS = 10_000;

export interface LoaderSnapshot {
	readonly bridge: BridgeState;
	/** Not connected for more than {@link DISCONNECT_RELOAD_MS} since boot or since the connection dropped. */
	readonly disconnectedLong: boolean;
	/** The agent's current build differs from the one this page runs (or the bridge moved ports). */
	readonly reloadPending: boolean;
	readonly status: AgentStatus | null;
	readonly update: UpdateStatus | null;
	readonly building: boolean;
	/** Keys of user actions still running (their controls render disabled). */
	readonly busy: readonly string[];
	/** The last failed user action's message. */
	readonly notice: string | null;
}

/** State behind the Better Grok Bot settings section, readable through `useSyncExternalStore`. */
export interface LoaderStore {
	getSnapshot(): LoaderSnapshot;
	subscribe(listener: () => void): () => void;
	setBridgeState(state: BridgeState): void;
	setStatus(status: AgentStatus): void;
	setUpdate(update: UpdateStatus): void;
	setBuilding(building: boolean): void;
	/** The agent's current build key, from `welcome` or an ok `build.finished`. */
	setCurrentBuildKey(key: string): void;
	/** `bridge.moving`: the port is part of the build key, so this page's build is outdated. */
	markMoved(): void;
	setNotice(notice: string | null): void;
	setBusy(action: string, busy: boolean): void;
}

export function createLoaderStore(runningBuildKey: string, clock: Clock, log: PluginLogger): LoaderStore {
	let snapshot: LoaderSnapshot = {
		bridge: "disconnected",
		disconnectedLong: false,
		reloadPending: false,
		status: null,
		update: null,
		building: false,
		busy: [],
		notice: null,
	};
	const listeners = new Set<() => void>();
	let moved = false;
	let currentBuildKey: string | null = null;
	let disconnectTimer: unknown = null;

	const update = (patch: Partial<LoaderSnapshot>): void => {
		snapshot = { ...snapshot, ...patch };
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch (error) {
				log.error("settings store listener threw:", error);
			}
		}
	};

	const startDisconnectTimer = (): void => {
		if (disconnectTimer !== null) clock.clearTimeout(disconnectTimer);
		disconnectTimer = clock.setTimeout(() => {
			disconnectTimer = null;
			if (snapshot.bridge !== "connected") update({ disconnectedLong: true });
		}, DISCONNECT_RELOAD_MS);
	};

	const reloadPending = (): boolean => moved || (currentBuildKey !== null && currentBuildKey !== runningBuildKey);

	// The page boots without a connection: the 10 s clock starts now.
	startDisconnectTimer();

	return Object.freeze({
		getSnapshot: () => snapshot,
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		setBridgeState(state: BridgeState): void {
			if (state === snapshot.bridge) return;
			const wasConnected = snapshot.bridge === "connected";
			if (state === "connected") {
				if (disconnectTimer !== null) clock.clearTimeout(disconnectTimer);
				disconnectTimer = null;
				update({ bridge: state, disconnectedLong: false });
				return;
			}
			if (wasConnected) startDisconnectTimer();
			update({ bridge: state });
		},
		setStatus(status: AgentStatus): void {
			update({ status, update: status.update, building: status.building });
		},
		setUpdate(next: UpdateStatus): void {
			update({ update: next });
		},
		setBuilding(building: boolean): void {
			if (building !== snapshot.building) update({ building });
		},
		setCurrentBuildKey(key: string): void {
			currentBuildKey = key;
			if (reloadPending() !== snapshot.reloadPending) update({ reloadPending: reloadPending() });
		},
		markMoved(): void {
			moved = true;
			if (!snapshot.reloadPending) update({ reloadPending: true });
		},
		setNotice(notice: string | null): void {
			if (notice !== snapshot.notice) update({ notice });
		},
		setBusy(action: string, busy: boolean): void {
			const has = snapshot.busy.includes(action);
			if (busy && !has) update({ busy: [...snapshot.busy, action] });
			else if (!busy && has) update({ busy: snapshot.busy.filter((key) => key !== action) });
		},
	});
}

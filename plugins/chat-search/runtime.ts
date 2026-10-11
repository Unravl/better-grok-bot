import type { ComponentFactory, PluginContext, UiDeps } from "@better-grok-bot/sdk";

export interface TranscriptSnapshot {
	entries: readonly { id: string }[];
	loadState: "loading" | "ready" | "failed";
	isShowingRestoredTranscript: boolean;
	hasOlder: boolean;
	isLoadingOlder: boolean;
	olderFailure: unknown;
	failure: unknown;
}

export interface TranscriptStore {
	get(): TranscriptSnapshot;
	subscribe(listener: () => void): () => void;
}

export interface HistoryActions {
	loadOlder(): Promise<void>;
	retry(): void;
}

interface TranscriptSource {
	store: TranscriptStore;
	actions: HistoryActions;
}

export interface HistoryStatus {
	phase: "loading" | "complete" | "error";
	pages: number;
	entries: number;
	error: string | null;
}

function failureMessage(failure: unknown): string {
	if (failure instanceof Error) return failure.message;
	if (typeof failure === "object" && failure !== null && "message" in failure && typeof failure.message === "string") return failure.message;
	return "Earlier messages could not be loaded.";
}

/** Traverses the native store, never a separate text index. A stopped run cannot request another page. */
export class HistorySearch {
	private generation = 0;
	private active = false;
	private busy = 0;
	private pending = false;
	private retryPending = false;
	private waitingBaselineRetry = false;
	private baselineRetryFailure: unknown;
	private unsubscribe: (() => void) | null = null;
	private readonly listeners = new Set<() => void>();
	private status: HistoryStatus;

	constructor(private readonly store: TranscriptStore, private readonly actions: HistoryActions) {
		this.status = { phase: "loading", pages: 0, entries: store.get().entries.length, error: null };
	}

	get = (): HistoryStatus => this.status;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	start = (): void => {
		if (this.active) return;
		this.active = true;
		this.generation += 1;
		this.pending = false;
		this.retryPending = false;
		this.unsubscribe = this.store.subscribe(() => {
			this.publish({ entries: this.store.get().entries.length });
			this.drive();
		});
		this.drive();
	};

	stop = (): void => {
		this.active = false;
		this.generation += 1;
		this.unsubscribe?.();
		this.unsubscribe = null;
	};

	retry = (): void => {
		if (!this.active || this.status.phase !== "error") return;
		this.publish({ phase: "loading", error: null });
		const snapshot = this.store.get();
		if (snapshot.loadState === "failed") {
			this.waitingBaselineRetry = true;
			this.baselineRetryFailure = snapshot.failure;
			try {
				this.actions.retry();
			} catch (error) {
				this.waitingBaselineRetry = false;
				this.publish({ phase: "error", error: failureMessage(error) });
				return;
			}
		}
		this.drive(true);
	};

	private publish(change: Partial<HistoryStatus>): void {
		this.status = { ...this.status, ...change };
		for (const listener of this.listeners) listener();
	}

	private drive(retry = false): void {
		if (!this.active || this.status.phase === "error") return;
		if (this.busy === this.generation) {
			this.pending = true;
			this.retryPending ||= retry;
			return;
		}
		const run = this.generation;
		this.busy = run;
		void this.load(run, retry).finally(() => {
			if (this.busy === run) this.busy = 0;
			if (this.active && this.generation === run && this.pending) {
				const retryNext = this.retryPending;
				this.pending = false;
				this.retryPending = false;
				this.drive(retryNext);
			}
		});
	}

	private async load(run: number, retry: boolean): Promise<void> {
		const current = () => this.active && this.generation === run;
		try {
			while (current()) {
				const before = this.store.get();
				if (before.loadState === "failed") {
					if (this.waitingBaselineRetry && before.failure === this.baselineRetryFailure) return;
					this.waitingBaselineRetry = false;
					throw new Error(failureMessage(before.failure));
				}
				if (before.loadState !== "ready" || before.isShowingRestoredTranscript || before.isLoadingOlder) return;
				this.waitingBaselineRetry = false;
				if (!before.hasOlder) {
					this.publish({ phase: "complete", entries: before.entries.length, error: null });
					return;
				}
				if (before.olderFailure != null && !retry) throw new Error(failureMessage(before.olderFailure));
				retry = false;
				this.publish({ phase: "loading", entries: before.entries.length, error: null });
				await this.actions.loadOlder();
				if (!current()) return;
				const after = this.store.get();
				this.publish({ pages: this.status.pages + 1, entries: after.entries.length });
				if (after.olderFailure != null) throw new Error(failureMessage(after.olderFailure));
				if (after.hasOlder && after.entries[0]?.id === before.entries[0]?.id) {
					throw new Error("Earlier history did not advance. Results cover loaded messages only; retry to continue.");
				}
			}
		} catch (error) {
			if (current()) this.publish({ phase: "error", error: failureMessage(error) });
		}
	}
}

function transcriptSource(client: unknown, agentId: string, sessionId: unknown): TranscriptSource | null {
	if (typeof client !== "object" || client === null || !("transcript" in client)) return null;
	const transcript = client.transcript;
	if (typeof transcript !== "object" || transcript === null || !("snapshotsFor" in transcript) || typeof transcript.snapshotsFor !== "function") return null;
	if (!("loadOlder" in transcript) || typeof transcript.loadOlder !== "function" || !("load" in transcript) || typeof transcript.load !== "function") return null;
	const store: unknown = transcript.snapshotsFor(agentId, { sessionId });
	if (typeof store !== "object" || store === null || !("get" in store) || typeof store.get !== "function" || !("subscribe" in store) || typeof store.subscribe !== "function") return null;
	const native = transcript as {
		loadOlder(agentId: string, options: { sessionId: unknown }): Promise<void>;
		load(agentId: string, options: { sessionId: unknown }): void;
	};
	return {
		store: store as TranscriptStore,
		actions: {
			loadOlder: () => native.loadOlder(agentId, { sessionId }),
			retry: () => native.load(agentId, { sessionId }),
		},
	};
}

function finderFactory(deps: UiDeps, ctx: PluginContext): (props: Record<string, unknown>) => unknown {
	const { React, jsx, NativeFinder, useSession } = deps;
	if (typeof useSession !== "function" || NativeFinder == null) throw new Error("Native chat finder dependencies are unavailable");
	let nextScopeKey = 0;

	function ConversationFinder(props: Record<string, unknown>): unknown {
		const source = props.source as TranscriptSource | null;
		const [history] = React.useState(() => source === null ? null : new HistorySearch(source.store, source.actions));
		const status = React.useSyncExternalStore(history?.subscribe ?? noSubscribe, history?.get ?? unavailableStatus);
		React.useEffect(() => {
			history?.start();
			return () => history?.stop();
		}, [history]);
		const close = () => {
			history?.stop();
			if (typeof props.onClose === "function") props.onClose();
		};
		const message = status.phase === "complete"
			? "All available history loaded for search."
			: status.phase === "loading"
				? `Searching earlier history… ${status.pages} pages loaded. Results are still incomplete.`
				: `${status.error} Results cover loaded messages only.`;
		return jsx("div", {
			className: "bgb-chat-search",
			children: [
				jsx(NativeFinder, {
					entries: props.entries,
					focusNonce: props.focusNonce,
					onClose: close,
					transcriptHandleRef: props.transcriptHandleRef,
				}),
				jsx("div", {
					className: "bgb-chat-search-history",
					role: status.phase === "error" ? "alert" : "status",
					"aria-live": "polite",
					"aria-busy": status.phase === "loading",
					children: [message, status.phase === "error" && history !== null ? jsx("button", {
						type: "button",
						onClick: history.retry,
						children: "Retry earlier history",
					}) : null],
				}),
			],
		});
	}

	return (props) => {
		const agentId = typeof props.agentId === "string" ? props.agentId : "";
		const sessionId: unknown = useSession(agentId || undefined);
		const client = ctx.app.client;
		const scope = React.useMemo(() => ({
			source: transcriptSource(client, agentId, sessionId),
			key: ++nextScopeKey,
		}), [client, agentId, sessionId]);
		// A client/store replacement also remounts traversal and the native query/highlight controller.
		return jsx(ConversationFinder, { ...props, source: scope.source }, `${agentId}\0${String(sessionId)}\0${scope.key}`);
	};
}

function noSubscribe(): () => void { return () => {}; }
const UNAVAILABLE_STATUS: HistoryStatus = { phase: "error", pages: 0, entries: 0, error: "Earlier history is unavailable in this app version." };
function unavailableStatus(): HistoryStatus { return UNAVAILABLE_STATUS; }

globalThis.BetterGrokBot?.define("chat-search", (ctx) => {
	let open: (() => void) | null = null;
	let preparedFinder: ((props: Record<string, unknown>) => unknown) | null = null;
	const SearchButton: ComponentFactory = ({ jsx }) => () => jsx("button", {
		className: "bgb-chat-search-button",
		type: "button",
		"aria-label": "Search this conversation",
		title: "Search this conversation",
		onClick: () => open?.(),
		children: [jsx("svg", {
			viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 2,
			"aria-hidden": true,
			children: [jsx("circle", { cx: 10.5, cy: 10.5, r: 6.5 }), jsx("path", { d: "m16 16 5 5" })],
		}), "Search"],
	});
	return {
		captureOpen(callback: unknown) {
			if (typeof callback === "function") open = callback as () => void;
			return callback;
		},
		SearchButton,
		selectFinder(deps: Partial<UiDeps>): unknown {
			const React = ctx.app.React;
			if (React === undefined || typeof deps.jsx !== "function") return undefined;
			// Preparation runs inside call()'s guard, so failure preserves the original native finder.
			preparedFinder ??= finderFactory({ ...deps, React, jsx: deps.jsx }, ctx);
			return globalThis.BetterGrokBot?.component("chat-search", "Finder", { ...deps, React });
		},
		Finder: () => {
			if (preparedFinder === null) throw new Error("Native finder has not been prepared");
			return preparedFinder;
		},
	};
});

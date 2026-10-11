import { describe, expect, test } from "bun:test";
import { HistorySearch, type HistoryStatus, type TranscriptSnapshot, type TranscriptStore } from "./runtime.ts";

function conversation(entries: string[], loadOlder: () => Promise<void>, retry: () => void = () => {}) {
	let snapshot: TranscriptSnapshot = {
		entries: entries.map((id) => ({ id })),
		loadState: "ready",
		isShowingRestoredTranscript: false,
		hasOlder: true,
		isLoadingOlder: false,
		olderFailure: null,
		failure: null,
	};
	const listeners = new Set<() => void>();
	const store: TranscriptStore = {
		get: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		store,
		actions: { loadOlder, retry },
		update(change: Partial<TranscriptSnapshot>) {
			snapshot = { ...snapshot, ...change };
			for (const listener of listeners) listener();
		},
		get subscriptions() { return listeners.size; },
	};
}

function terminal(history: HistorySearch): Promise<HistoryStatus> {
	if (history.get().phase !== "loading") return Promise.resolve(history.get());
	const { promise, resolve } = Promise.withResolvers<HistoryStatus>();
	const unsubscribe = history.subscribe(() => {
		if (history.get().phase === "loading") return;
		unsubscribe();
		resolve(history.get());
	});
	return promise;
}

function pendingPage() {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, release: resolve };
}

// These tests exercise native-store traversal boundaries, not another text matcher or patch strings.
describe("searching earlier conversation history", () => {
	test("loads every older page, including more than the app's single-jump page budget", async () => {
		let pages = 0;
		const feed = conversation(["latest"], async () => {
			pages += 1;
			feed.update({
				entries: [{ id: `older-${pages}` }, ...feed.store.get().entries],
				hasOlder: pages < 25,
			});
		});
		const history = new HistorySearch(feed.store, feed.actions);
		history.start();
		expect(await terminal(history)).toEqual({ phase: "complete", pages: 25, entries: 26, error: null });
		expect(feed.store.get().entries[0]?.id).toBe("older-25");
		history.stop();
	});

	test("waits for restored/loading snapshots instead of declaring incomplete history complete", async () => {
		let calls = 0;
		const feed = conversation([], async () => { calls += 1; });
		feed.update({ loadState: "loading", isShowingRestoredTranscript: true, hasOlder: false });
		const history = new HistorySearch(feed.store, feed.actions);
		history.start();
		expect(history.get().phase).toBe("loading");
		expect(calls).toBe(0);
		await Promise.resolve();
		await Promise.resolve();
		feed.update({ loadState: "ready", isShowingRestoredTranscript: false, entries: [{ id: "restored" }] });
		expect(await terminal(history)).toMatchObject({ phase: "complete", entries: 1 });
		history.stop();
	});

	test("reports native history failures and retries through loadOlder", async () => {
		let calls = 0;
		const feed = conversation(["recent"], async () => {
			calls += 1;
			if (calls === 1) {
				feed.update({ olderFailure: { message: "Offline" } });
				return;
			}
			feed.update({ olderFailure: null, entries: [{ id: "old" }, ...feed.store.get().entries], hasOlder: false });
		});
		const history = new HistorySearch(feed.store, feed.actions);
		history.start();
		expect(await terminal(history)).toMatchObject({ phase: "error", error: "Offline" });
		await Promise.resolve();
		await Promise.resolve();
		history.retry();
		expect(await terminal(history)).toMatchObject({ phase: "complete", entries: 2 });
		expect(calls).toBe(2);
		history.stop();
	});

	test("does not spin when a successful native load makes no history progress", async () => {
		let calls = 0;
		const feed = conversation(["recent"], async () => { calls += 1; });
		const history = new HistorySearch(feed.store, feed.actions);
		history.start();
		expect(await terminal(history)).toMatchObject({ phase: "error", pages: 1 });
		expect(history.get().error).toContain("did not advance");
		expect(calls).toBe(1);
		history.stop();
	});

	test("closing during a native request stops continuation and ignores its eventual failure", async () => {
		const page = pendingPage();
		let calls = 0;
		const feed = conversation(["recent"], async () => {
			calls += 1;
			await page.promise;
			throw new Error("Late failure");
		});
		const history = new HistorySearch(feed.store, feed.actions);
		history.start();
		history.stop();
		const statusAtClose = history.get();
		page.release();
		await page.promise;
		await Promise.resolve();
		expect(calls).toBe(1);
		expect(history.get()).toBe(statusAtClose);
		expect(feed.subscriptions).toBe(0);
	});

	test("switching conversations never continues loading the previous bot", async () => {
		const page = pendingPage();
		let oldCalls = 0;
		const oldFeed = conversation(["old-bot-recent"], async () => {
			oldCalls += 1;
			await page.promise;
			oldFeed.update({ entries: [{ id: "old-bot-earlier" }, ...oldFeed.store.get().entries] });
		});
		const oldHistory = new HistorySearch(oldFeed.store, oldFeed.actions);
		oldHistory.start();
		oldHistory.stop();
		const nextFeed = conversation(["next-bot"], async () => { nextFeed.update({ hasOlder: false }); });
		const nextHistory = new HistorySearch(nextFeed.store, nextFeed.actions);
		nextHistory.start();
		expect(await terminal(nextHistory)).toMatchObject({ phase: "complete", entries: 1 });
		page.release();
		await page.promise;
		await Promise.resolve();
		expect(oldCalls).toBe(1);
		expect(oldFeed.subscriptions).toBe(0);
		expect(nextHistory.get().entries).toBe(1);
		nextHistory.stop();
	});
});

describe("baseline history completeness", () => {
	test("a failed baseline is incomplete even with an empty exhausted window or restored entries", async () => {
		for (const restored of [false, true]) {
			const feed = conversation(restored ? ["restored"] : [], async () => {});
			feed.update({ loadState: "failed", hasOlder: false, isShowingRestoredTranscript: restored, failure: { message: "Baseline offline" } });
			const history = new HistorySearch(feed.store, feed.actions);
			history.start();
			expect(await terminal(history)).toMatchObject({ phase: "error", error: "Baseline offline" });
			history.stop();
		}
	});

	test("retry uses the native baseline action and waits for its replacement snapshot", async () => {
		let retries = 0;
		let olderCalls = 0;
		const failure = { message: "Baseline offline" };
		const feed = conversation([], async () => { olderCalls += 1; }, () => { retries += 1; });
		feed.update({ loadState: "failed", hasOlder: false, failure });
		const history = new HistorySearch(feed.store, feed.actions);
		history.start();
		expect(await terminal(history)).toMatchObject({ phase: "error" });
		history.retry();
		await Promise.resolve();
		await Promise.resolve();
		expect(retries).toBe(1);
		expect(olderCalls).toBe(0);
		expect(history.get().phase).toBe("loading");
		feed.update({ loadState: "ready", failure: null, entries: [{ id: "recovered" }] });
		expect(await terminal(history)).toMatchObject({ phase: "complete", entries: 1 });
		history.stop();
	});

	test("a repeated native baseline failure is reported rather than declaring completeness", async () => {
		const feed = conversation([], async () => {});
		feed.update({ loadState: "failed", hasOlder: false, failure: { message: "First failure" } });
		const history = new HistorySearch(feed.store, feed.actions);
		history.start();
		await terminal(history);
		history.retry();
		feed.update({ failure: { message: "Retry failed" } });
		expect(await terminal(history)).toMatchObject({ phase: "error", error: "Retry failed" });
		history.stop();
	});
});

import { describe, expect, test } from "bun:test";
import type { PluginContext, SidebarCommand, SidebarResult } from "@better-grok-bot/sdk";
import {
	createSidebarFolders,
	orderByIds,
	parseSections,
	placeAgent,
	resolveRead,
	STORAGE_KEY,
	type Section,
	type SidebarFoldersRuntime,
	slotAt,
	UNSECTIONED_ID,
} from "./runtime.ts";

const sections: Section[] = [
	{ id: "a", name: "A", agentIds: ["1", "2", "3"] },
	{ id: "b", name: "B", agentIds: ["4"] },
	{ id: UNSECTIONED_ID, name: "", agentIds: [] },
];

describe("orderByIds", () => {
	test("follows agentIds and keeps unknown bots after, in their order", () => {
		const agents = [{ id: "x" }, { id: "3" }, { id: "1" }, { id: "y" }, { id: "2" }];
		expect(orderByIds(agents, ["1", "2", "3"]).map((a) => a.id)).toEqual(["1", "2", "3", "x", "y"]);
	});
});

describe("placeAgent", () => {
	test("reorders inside a section", () => {
		expect(placeAgent(sections, "3", "a", "1", null)?.[0]?.agentIds).toEqual(["3", "1", "2"]);
		expect(placeAgent(sections, "1", "a", null, "3")?.[0]?.agentIds).toEqual(["2", "3", "1"]);
		expect(placeAgent(sections, "1", "a", null, null)?.[0]?.agentIds).toEqual(["2", "3", "1"]);
	});

	test("moves between sections at the position and leaves the rest alone", () => {
		const next = placeAgent(sections, "4", "a", "2", "1");
		expect(next?.[0]?.agentIds).toEqual(["1", "4", "2", "3"]);
		expect(next?.[1]?.agentIds).toEqual([]);
		expect(next?.[2]).toBe(sections[2]);
	});

	test("unknown section is null", () => {
		expect(placeAgent(sections, "1", "nope", null, null)).toBeNull();
	});
});

describe("slotAt", () => {
	const rows = [
		{ id: "1", top: 0, bottom: 30 },
		{ id: "2", top: 30, bottom: 60 },
	];
	test("picks neighbours by row midpoints", () => {
		expect(slotAt(rows, 5)).toEqual({ beforeId: "1", afterId: null, lineY: 0 });
		expect(slotAt(rows, 20)).toEqual({ beforeId: "2", afterId: "1", lineY: 30 });
		expect(slotAt(rows, 59)).toEqual({ beforeId: null, afterId: "2", lineY: 60 });
		expect(slotAt([], 10)).toEqual({ beforeId: null, afterId: null, lineY: null });
	});
});

describe("parseSections", () => {
	test("keeps well-formed sections and drops the rest", () => {
		expect(
			parseSections([
				{ id: "a", name: "A", agentIds: ["1", 2, ""], isCollapsed: true },
				{ id: "a", name: "dup", agentIds: [] },
				{ id: "", name: "x", agentIds: [] },
				{ id: "b", name: 3, agentIds: [] },
				null,
			]),
		).toEqual([{ id: "a", name: "A", agentIds: ["1"] }]);
		expect(parseSections(null)).toBeNull();
		expect(parseSections({})).toBeNull();
	});
});

describe("resolveRead", () => {
	test("the computer's list wins; else the local copy; else no folders", () => {
		expect(resolveRead([{ id: "h", name: "H", agentIds: [] }], [{ id: "l", name: "L", agentIds: [] }])).toEqual({
			sections: [{ id: "h", name: "H", agentIds: [] }],
			source: "host",
		});
		expect(resolveRead(null, [{ id: "l", name: "L", agentIds: ["1"] }])).toEqual({
			sections: [{ id: "l", name: "L", agentIds: ["1"] }],
			source: "local",
		});
		expect(resolveRead(undefined, null)).toEqual({ sections: [], source: "local" });
	});
});

/** A plugin context with in-memory storage, enough for the storage functions. */
function fakeContext(initial: Record<string, unknown> = {}): { ctx: PluginContext; store: Map<string, unknown> } {
	const store = new Map(Object.entries(initial));
	const ctx = {
		id: "sidebar-folders",
		log: { info() {}, warn() {}, error() {} },
		storage: {
			get: <T>(key: string, fallback: T): T => (store.has(key) ? (store.get(key) as T) : fallback),
			set: (key: string, value: unknown) => void store.set(key, value),
			subscribe: () => () => {},
		},
		app: { client: undefined },
	} as unknown as PluginContext;
	return { ctx, store };
}

const folder = { id: "f", name: "Work", agentIds: ["1", "2"] };

describe("folder storage", () => {
	test("computer without sections: reads the local copy, writes are kept locally and answered", async () => {
		const { ctx, store } = fakeContext({ [STORAGE_KEY]: [folder] });
		const plugin = createSidebarFolders(ctx);
		expect(await plugin.readSections(Promise.resolve(null))).toEqual([folder]);
		const next = [{ ...folder, agentIds: ["2", "1"] }];
		expect(await plugin.writeSections(Promise.resolve(null), next)).toEqual(next);
		expect(store.get(STORAGE_KEY)).toEqual(next);
		// Unreachable computer while folders are local: still saved and answered.
		expect(await plugin.writeSections(Promise.reject(new Error("offline")), [])).toEqual([]);
		expect(store.get(STORAGE_KEY)).toEqual([]);
	});

	test("first run with nothing anywhere: an empty list, so folders can be created", async () => {
		const { ctx } = fakeContext();
		expect(await createSidebarFolders(ctx).readSections(Promise.resolve(null))).toEqual([]);
	});

	test("computer with sections: its answer wins and is mirrored; its errors pass through", async () => {
		const { ctx, store } = fakeContext({ [STORAGE_KEY]: [] });
		const plugin = createSidebarFolders(ctx);
		expect(await plugin.readSections(Promise.resolve([folder]))).toEqual([folder]);
		expect(store.get(STORAGE_KEY)).toEqual([folder]);
		await expect(plugin.writeSections(Promise.reject(new Error("offline")), [])).rejects.toThrow("offline");
	});

	test("read failure falls back to the local copy, or fails without one", async () => {
		expect(await createSidebarFolders(fakeContext({ [STORAGE_KEY]: [folder] }).ctx).readSections(Promise.reject(new Error("x")))).toEqual([folder]);
		await expect(createSidebarFolders(fakeContext().ctx).readSections(Promise.reject(new Error("x")))).rejects.toThrow("x");
	});

	test("anything but a pending request is left to the app", () => {
		const plugin = createSidebarFolders(fakeContext().ctx);
		expect(plugin.readSections(null)).toBeUndefined();
		expect(plugin.writeSections(Promise.resolve(null), "nope")).toBeUndefined();
	});
});

const commandSections: Section[] = [
	{ id: "work", name: "Work", agentIds: ["one", "two"] },
	{ id: "play", name: "Play", agentIds: ["three"] },
	{ id: UNSECTIONED_ID, name: "", agentIds: [] },
];
const commandRows = [
	{ id: "one", name: "One" },
	{ id: "two", name: "Two" },
	{ id: "three", name: "Three" },
	{ id: "free", name: "Free" },
];

type CommandOutcome =
	| { status: "fulfilled"; value: SidebarResult }
	| { status: "rejected"; error: unknown };

function captureCommandOutcome(command: Promise<SidebarResult>): Promise<CommandOutcome> {
	return command.then<CommandOutcome, CommandOutcome>(
		(value) => ({ status: "fulfilled", value }),
		(error: unknown) => ({ status: "rejected", error }),
	);
}

const heldRequest = () => Promise.withResolvers<unknown>();

/** Optimistic native edits queue real plugin writes; only returned persistence state is published. */
async function nativeFixture(initial: readonly Section[] = commandSections, rows: readonly unknown[] = commandRows, hostSupported = true) {
	const local = new Map<string, unknown>([[STORAGE_KEY, initial]]);
	const clientListeners = new Set<(client: unknown) => void>();
	let latestClient: unknown;
	const storage = {
		fail: false,
		strictWrites: [] as boolean[],
		get: <T>(key: string, fallback: T): T => local.has(key) ? local.get(key) as T : fallback,
		set(key: string, value: unknown, options?: { requirePersistence?: boolean }) {
			storage.strictWrites.push(options?.requirePersistence === true);
			if (storage.fail) throw new Error("disk full");
			local.set(key, value);
		},
		subscribe: () => () => {},
	};
	const ctx = {
		id: "sidebar-folders",
		log: { info() {}, warn() {}, error() {} },
		storage,
		app: {
			get client() { return latestClient; },
			onClient(listener: (client: unknown) => void) {
				clientListeners.add(listener);
				queueMicrotask(() => {
					if (clientListeners.has(listener) && latestClient !== undefined) listener(latestClient);
				});
				return () => { clientListeners.delete(listener); };
			},
		},
	} as unknown as PluginContext;
	const plugin: SidebarFoldersRuntime = createSidebarFolders(ctx);
	await plugin.readSections(Promise.resolve(hostSupported ? initial : null));

	function makeClient(sections: readonly Section[], botRows: readonly unknown[]) {
		const failureListeners = new Set<() => void>();
		const writeWaiters = new Set<{ count: number; resolve: () => void }>();
		const state = {
			sections: sections as readonly Section[] | null,
			persisted: sections,
			phase: { kind: "confirmed", sections },
			intent: sections,
			generation: 0,
			ops: Promise.resolve(),
			snapshot: { loadState: "ready", isShowingRestoredRoster: false, agents: { rows: botRows } } as unknown,
			failure: null as unknown,
			beforeEdit: undefined as (() => void) | undefined,
			editNoop: false,
			createId: "native-generated-folder" as string | null,
			edits: 0,
			createCalls: [] as readonly string[][],
			writes: [] as (readonly Section[])[],
			hostRequests: [] as ((next: readonly Section[]) => Promise<unknown>)[],
			hostReply: (next: readonly Section[]): Promise<unknown> => Promise.resolve(hostSupported ? next : null),
			normalize: (next: readonly Section[]): readonly Section[] => next,
		};
		const publishFailure = (value: unknown): void => {
			state.failure = value;
			for (const listener of failureListeners) listener();
		};
		const store = {
			sections: { get: () => state.sections },
			get phase() { return state.phase; },
			get intent() { return state.intent; },
			get generation() { return state.generation; },
			get ops() { return state.ops; },
			failure: {
				get: () => state.failure,
				subscribe(listener: () => void) {
					failureListeners.add(listener);
					return () => { failureListeners.delete(listener); };
				},
			},
			edit(update: (current: readonly Section[]) => readonly Section[]): void {
				state.edits++;
				state.beforeEdit?.();
				if (state.editNoop || state.sections === null) return;
				const next = state.normalize(update(state.sections));
				state.intent = next;
				state.sections = next;
				state.ops = state.ops.then(async () => {
					for (;;) {
						state.writes.push(next);
						for (const waiter of writeWaiters) {
							if (state.writes.length < waiter.count) continue;
							writeWaiters.delete(waiter);
							waiter.resolve();
						}
						const hostRequest = state.hostRequests.shift() ?? state.hostReply;
						try {
							const persisted = await plugin.writeSections(hostRequest(next), next);
							if (persisted === undefined) throw new Error("native write was not handled");
							state.persisted = persisted;
							state.sections = persisted;
							state.phase = { kind: "confirmed", sections: persisted };
							publishFailure(null);
							return;
						} catch {
							// The fixture's scripted requests model retries, not a fixed native retry count.
							if (state.hostRequests.length > 0) continue;
							publishFailure({ operation: "write" });
							state.sections = state.persisted;
							const refreshed = await plugin.readSections(Promise.resolve(hostSupported ? state.persisted : null));
							if (refreshed !== undefined) state.sections = refreshed;
							state.phase = { kind: "confirmed", sections: state.persisted };
							return;
						}
					}
				}).catch(() => {});
			},
			commands: {
				create(agentIds: readonly string[]): string | null {
					state.createCalls = [...state.createCalls, [...agentIds]];
					const id = state.createId;
					if (id === null || state.sections === null) return null;
					store.edit((current) => [{ id, name: "New folder", agentIds }, ...current]);
					return id;
				},
			},
		};
		const client = { sidebarSections: store, roster: { snapshots: { get: () => state.snapshot } } };
		const waitForWrites = (count: number): Promise<void> => {
			if (state.writes.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			writeWaiters.add({ count, resolve });
			return promise;
		};
		return { client, state, publishFailure, failureListeners, waitForWrites };
	}
	const native = makeClient(initial, rows);
	const setClient = (client: unknown): void => {
		latestClient = client;
		for (const listener of clientListeners) listener(client);
	};
	setClient(native.client);
	return { plugin, native, makeClient, setClient, storage, local, clientListeners };
}

describe("sidebar folder commands", () => {
	test("lists native folder order and only visible bots, with safe display-name fallbacks", async () => {
		const fixture = await nativeFixture([
			{ id: "work", name: "Work", agentIds: ["two", "hidden", "missing", "one", "group"] },
			{ id: "play", name: "Play", agentIds: ["fallback", "blank"] },
			{ id: UNSECTIONED_ID, name: "", agentIds: ["free"] },
		], [
			{ id: "one", name: "  One  " },
			{ id: "hidden", name: "Hidden", isHiddenFromSidebar: true },
			{ id: "group", name: "Group", isGroup: true },
			{ id: "two", name: "Two" },
			{ id: "fallback" },
			{ id: "blank", name: " \t " },
			{ id: "free", name: "Free" },
		]);
		expect(await fixture.plugin.executeSidebar({ operation: "list-folders" })).toEqual({
			operation: "list-folders",
			folders: [
				{ id: "work", name: "Work", botIds: ["two", "one"] },
				{ id: "play", name: "Play", botIds: ["fallback", "blank"] },
			],
		});
		expect(await fixture.plugin.executeSidebar({ operation: "list-bots" })).toEqual({
			operation: "list-bots",
			bots: [
				{ id: "one", name: "One", folderId: "work" },
				{ id: "two", name: "Two", folderId: "work" },
				{ id: "fallback", name: "fallback", folderId: "play" },
				{ id: "blank", name: "blank", folderId: "play" },
				{ id: "free", name: "Free", folderId: null },
			],
		});
		expect(fixture.native.state.edits).toBe(0);
	});

	test("moves between folders by appending, stripping all old duplicate memberships", async () => {
		const fixture = await nativeFixture([
			{ id: "work", name: "Work", agentIds: ["one", "two", "one"] },
			{ id: "play", name: "Play", agentIds: ["three"] },
			{ id: "extra", name: "Extra", agentIds: ["free", "one"] },
			{ id: UNSECTIONED_ID, name: "", agentIds: ["one"] },
		]);
		expect(await fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "play" })).toEqual({
			operation: "move-bot", bot: { id: "one", name: "One", folderId: "play" },
		});
		const expected = [
			{ id: "work", name: "Work", agentIds: ["two"] },
			{ id: "play", name: "Play", agentIds: ["three", "one"] },
			{ id: "extra", name: "Extra", agentIds: ["free"] },
			{ id: UNSECTIONED_ID, name: "", agentIds: [] },
		];
		expect(fixture.native.state.sections).toEqual(expected);
		expect(fixture.local.get(STORAGE_KEY)).toEqual(expected);
		expect(fixture.native.state.writes).toEqual([expected]);
	});

	test("same-folder move preserves its position while confirming its own native write", async () => {
		const fixture = await nativeFixture();
		expect(await fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "work" })).toEqual({
			operation: "move-bot", bot: { id: "one", name: "One", folderId: "work" },
		});
		expect(fixture.native.state.sections).toEqual(commandSections);
		expect(fixture.native.state.edits).toBe(1);
		expect(fixture.native.state.writes).toEqual([commandSections]);
	});

	test("same-folder cleanup keeps the first destination position and removes stale duplicates", async () => {
		const fixture = await nativeFixture([
			{ id: "work", name: "Work", agentIds: ["two", "one", "three", "one"] },
			{ id: "play", name: "Play", agentIds: ["one", "free"] },
			{ id: UNSECTIONED_ID, name: "", agentIds: ["one"] },
		]);
		await fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "work" });
		expect(fixture.native.state.sections).toEqual([
			{ id: "work", name: "Work", agentIds: ["two", "one", "three"] },
			{ id: "play", name: "Play", agentIds: ["free"] },
			{ id: UNSECTIONED_ID, name: "", agentIds: [] },
		]);
		expect(fixture.native.state.writes).toHaveLength(1);
	});

	test("null strips every membership while preserving others, and repeated unassignment confirms its own write", async () => {
		const fixture = await nativeFixture([
			{ id: "work", name: "Work", agentIds: ["two", "one", "three", "one"] },
			{ id: "play", name: "Play", agentIds: ["one", "free"] },
			{ id: UNSECTIONED_ID, name: "", agentIds: ["one", "two"] },
		]);
		expect(await fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: null })).toEqual({
			operation: "move-bot", bot: { id: "one", name: "One", folderId: null },
		});
		expect(fixture.native.state.sections).toEqual([
			{ id: "work", name: "Work", agentIds: ["two", "three"] },
			{ id: "play", name: "Play", agentIds: ["free"] },
			{ id: UNSECTIONED_ID, name: "", agentIds: ["two"] },
		]);
		await fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: null });
		expect(fixture.native.state.edits).toBe(2);
	});

	test("creates through native create([]), retaining its generated ID and applying a normalized name", async () => {
		const fixture = await nativeFixture();
		expect(await fixture.plugin.executeSidebar({ operation: "create-folder", name: "  Cafe\u0301  " })).toEqual({
			operation: "create-folder",
			folder: { id: "native-generated-folder", name: "Café", botIds: [] },
		});
		expect(fixture.native.state.createCalls).toEqual([[]]);
		expect(fixture.native.state.sections).toEqual([
			{ id: "native-generated-folder", name: "Café", agentIds: [] }, ...commandSections,
		]);
		expect(fixture.native.state.writes).toHaveLength(2);
		expect(fixture.local.get(STORAGE_KEY)).toEqual(fixture.native.state.sections);
	});

	test("deletes only the container and reports visible bots that actually became unassigned once", async () => {
		const fixture = await nativeFixture([
			{ id: "work", name: "Work", agentIds: ["one", "one", "two", "hidden", "group", "gone"] },
			{ id: "play", name: "Play", agentIds: ["three", "two", "free"] },
			{ id: UNSECTIONED_ID, name: "", agentIds: [] },
		], [...commandRows, { id: "hidden", isHiddenFromSidebar: true }, { id: "group", isGroup: true }]);
		const roster = fixture.native.state.snapshot;
		expect(await fixture.plugin.executeSidebar({ operation: "delete-folder", folder: "work" })).toEqual({
			operation: "delete-folder",
			deletedFolder: { id: "work", name: "Work", botIds: ["one", "two"] },
			unassignedBotIds: ["one"],
		});
		expect(fixture.native.state.sections).toEqual([
			{ id: "play", name: "Play", agentIds: ["three", "two", "free"] },
			{ id: UNSECTIONED_ID, name: "", agentIds: [] },
		]);
		expect(fixture.native.state.snapshot).toBe(roster);
		expect(await fixture.plugin.executeSidebar({ operation: "list-bots" })).toMatchObject({
			bots: [
				{ id: "one", folderId: null }, { id: "two", folderId: "play" },
				{ id: "three", folderId: "play" }, { id: "free", folderId: "play" },
			],
		});
	});

	test("deleting the last real folder confirms a native normalized empty write", async () => {
		const fixture = await nativeFixture([
			{ id: "work", name: "Work", agentIds: ["one", "two"] },
			{ id: UNSECTIONED_ID, name: "", agentIds: [] },
		]);
		fixture.native.state.normalize = (next) => next.some((section) => section.id !== UNSECTIONED_ID) ? next : [];
		expect(await fixture.plugin.executeSidebar({ operation: "delete-folder", folder: "work" })).toEqual({
			operation: "delete-folder",
			deletedFolder: { id: "work", name: "Work", botIds: ["one", "two"] },
			unassignedBotIds: ["one", "two"],
		});
		expect(fixture.native.state.writes).toEqual([[]]);
		expect(fixture.native.state.sections).toEqual([]);
		expect(await fixture.plugin.executeSidebar({ operation: "list-folders" })).toEqual({ operation: "list-folders", folders: [] });
	});

	test("selectors prefer IDs to colliding names and fall back to trimmed NFC case-insensitive names", async () => {
		const fixture = await nativeFixture([
			{ id: "work", name: "Café", agentIds: [] },
			{ id: "other", name: "work", agentIds: [] },
		], [{ id: "one", name: "Résumé" }, { id: "other-bot", name: "one" }]);
		expect(await fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "work" })).toEqual({
			operation: "move-bot", bot: { id: "one", name: "Résumé", folderId: "work" },
		});
		expect(await fixture.plugin.executeSidebar({ operation: "move-bot", bot: "  RE\u0301SUME\u0301  ", folder: "other" })).toEqual({
			operation: "move-bot", bot: { id: "one", name: "Résumé", folderId: "other" },
		});
		expect(await fixture.plugin.executeSidebar({ operation: "move-bot", bot: " one ", folder: "  CAFE\u0301  " })).toMatchObject({
			bot: { id: "one", folderId: "work" },
		});
	});

	const selectorErrors: { name: string; command: SidebarCommand; code: string; candidates?: { id: string; name: string }[] }[] = [
		{ name: "missing bot ID", command: { operation: "move-bot", bot: "missing-id", folder: "work" }, code: "not-found" },
		{ name: "missing bot name", command: { operation: "move-bot", bot: "Nobody Here", folder: null }, code: "not-found" },
		{ name: "missing folder ID", command: { operation: "move-bot", bot: "one", folder: "missing-id" }, code: "not-found" },
		{ name: "missing folder name", command: { operation: "delete-folder", folder: "Nobody Here" }, code: "not-found" },
		{ name: "ambiguous bot name", command: { operation: "move-bot", bot: " re\u0301sume\u0301 ", folder: "work" }, code: "conflict", candidates: [{ id: "one", name: "Résumé" }, { id: "two", name: "RÉSUMÉ" }] },
		{ name: "ambiguous folder name", command: { operation: "delete-folder", folder: " cafe\u0301 " }, code: "conflict", candidates: [{ id: "work", name: "Café" }, { id: "play", name: "CAFÉ" }] },
	];
	for (const entry of selectorErrors) {
		test(`rejects ${entry.name} without editing`, async () => {
			const fixture = await nativeFixture([
				{ id: "work", name: "Café", agentIds: ["one"] },
				{ id: "play", name: "CAFÉ", agentIds: ["two"] },
			], [{ id: "one", name: "Résumé" }, { id: "two", name: "RÉSUMÉ" }]);
			await expect(fixture.plugin.executeSidebar(entry.command)).rejects.toMatchObject({
				code: entry.code, ...(entry.candidates ? { data: { candidates: entry.candidates } } : {}),
			});
			expect(fixture.native.state.edits).toBe(0);
		});
	}

	const protectedCommands: { command: SidebarCommand; code: string }[] = [
		{ command: { operation: "create-folder", name: " \t " }, code: "bad-request" },
		{ command: { operation: "move-bot", bot: " ", folder: "work" }, code: "bad-request" },
		{ command: { operation: "move-bot", bot: "one", folder: " " }, code: "bad-request" },
		{ command: { operation: "delete-folder", folder: " " }, code: "bad-request" },
		{ command: { operation: "create-folder", name: " work " }, code: "conflict" },
		{ command: { operation: "create-folder", name: " unASSIGNED " }, code: "conflict" },
		{ command: { operation: "move-bot", bot: "one", folder: UNSECTIONED_ID }, code: "bad-request" },
		{ command: { operation: "move-bot", bot: "one", folder: " Unassigned " }, code: "bad-request" },
		{ command: { operation: "delete-folder", folder: UNSECTIONED_ID }, code: "bad-request" },
		{ command: { operation: "delete-folder", folder: "unassigned" }, code: "bad-request" },
	];
	for (const { command, code } of protectedCommands) {
		test(`protects ${JSON.stringify(command)}`, async () => {
			const fixture = await nativeFixture();
			await expect(fixture.plugin.executeSidebar(command)).rejects.toMatchObject({ code });
			expect(fixture.native.state.edits).toBe(0);
			expect(fixture.native.state.createCalls).toEqual([]);
		});
	}

	test("reads the latest client and live roster for each command", async () => {
		const fixture = await nativeFixture();
		await fixture.plugin.executeSidebar({ operation: "list-folders" });
		const replacement = fixture.makeClient([{ id: "latest", name: "Latest", agentIds: [] }], [{ id: "new-bot", name: "New Bot" }]);
		fixture.setClient(replacement.client);
		expect(await fixture.plugin.executeSidebar({ operation: "move-bot", bot: "new-bot", folder: "latest" })).toMatchObject({
			bot: { id: "new-bot", name: "New Bot", folderId: "latest" },
		});
		replacement.state.snapshot = { loadState: "ready", isShowingRestoredRoster: false, agents: { rows: [{ id: "new-bot", name: "Renamed" }] } };
		expect(await fixture.plugin.executeSidebar({ operation: "list-bots" })).toEqual({
			operation: "list-bots", bots: [{ id: "new-bot", name: "Renamed", folderId: "latest" }],
		});
		expect(fixture.native.state.edits).toBe(0);
	});

	test("serializes queued mutations and preserves unrelated UI edits made before the updater", async () => {
		const fixture = await nativeFixture();
		const held = heldRequest();
		fixture.native.state.hostRequests.push(() => held.promise);
		const first = fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "play" });
		const second = fixture.plugin.executeSidebar({ operation: "move-bot", bot: "two", folder: "play" });
		await fixture.native.waitForWrites(1);
		try {
			expect(fixture.native.state.edits).toBe(1);
			fixture.native.state.beforeEdit = () => {
				fixture.native.state.beforeEdit = undefined;
				fixture.native.state.sections = [
					...(fixture.native.state.sections ?? []).map((section) => section.id === "play" ? { ...section, name: "UI renamed", agentIds: [...section.agentIds, "free"] } : section),
					{ id: "ui-added", name: "UI added", agentIds: [] },
				];
			};
		} finally {
			held.resolve(fixture.native.state.writes[0]);
		}
		await first;
		await second;
		expect(fixture.native.state.sections).toEqual([
			{ id: "work", name: "Work", agentIds: [] },
			{ id: "play", name: "UI renamed", agentIds: ["three", "one", "free", "two"] },
			{ id: UNSECTIONED_ID, name: "", agentIds: [] },
			{ id: "ui-added", name: "UI added", agentIds: [] },
		]);
		expect(fixture.native.state.writes).toHaveLength(2);
	});

	test("optimistic edits and unrelated write completions cannot confirm a held host write", async () => {
		const fixture = await nativeFixture();
		const held = heldRequest();
		fixture.native.state.hostRequests.push(() => held.promise);
		let settled = false;
		const command = fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "play" });
		void command.then(() => { settled = true; }, () => { settled = true; });
		await fixture.native.waitForWrites(1);
		try {
			expect(fixture.native.state.sections?.[1]?.agentIds).toEqual(["three", "one"]);
			await fixture.plugin.writeSections(Promise.resolve(commandSections), commandSections);
			fixture.native.publishFailure({ operation: "write" });
			await Promise.resolve();
			expect(settled).toBe(false);
		} finally {
			held.resolve(fixture.native.state.writes[0]);
		}
		expect(await command).toMatchObject({ bot: { id: "one", folderId: "play" } });
		expect(fixture.clientListeners.size).toBe(0);
		expect(fixture.native.failureListeners.size).toBe(0);
	});

	test("publishes the actual persisted host response before returning success", async () => {
		const fixture = await nativeFixture();
		fixture.native.state.hostReply = (next) => Promise.resolve(next.map((section) => section.id === "play" ? { ...section, name: "Host renamed", agentIds: ["one", "three"] } : section));
		expect(await fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "play" })).toMatchObject({
			bot: { id: "one", folderId: "play" },
		});
		expect(fixture.native.state.sections?.[1]).toEqual({ id: "play", name: "Host renamed", agentIds: ["one", "three"] });
		expect(fixture.local.get(STORAGE_KEY)).toEqual(fixture.native.state.sections);
	});

	test("a completed write returning the old membership is a conflict, not a successful move", async () => {
		const fixture = await nativeFixture();
		fixture.native.state.hostReply = () => Promise.resolve(commandSections);
		await expect(fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "play" })).rejects.toMatchObject({
			code: "conflict",
		});
		expect(fixture.native.state.sections).toEqual(commandSections);
	});

	test("a completed native creation with a different persisted name is a conflict", async () => {
		const fixture = await nativeFixture();
		fixture.native.state.hostReply = (next) => Promise.resolve(next.map((section) => section.id === "native-generated-folder" ? { ...section, name: "Host changed" } : section));
		await expect(fixture.plugin.executeSidebar({ operation: "create-folder", name: "Requested" })).rejects.toMatchObject({
			code: "conflict", data: { createdFolderId: "native-generated-folder" },
		});
		expect(fixture.native.state.sections?.[0]?.name).toBe("Host changed");
	});

	test("creation rejects names equivalent after trimming and NFC normalization", async () => {
		const fixture = await nativeFixture([{ id: "work", name: " Café ", agentIds: [] }]);
		await expect(fixture.plugin.executeSidebar({ operation: "create-folder", name: " CAFE\u0301 " })).rejects.toMatchObject({
			code: "conflict", data: { candidates: [{ id: "work", name: " Café " }] },
		});
		expect(fixture.native.state.createCalls).toEqual([]);
		expect(fixture.native.state.edits).toBe(0);
	});

	test("a final native host write failure rejects and releases subscriptions; the next command still works", async () => {
		const fixture = await nativeFixture();
		fixture.native.state.hostRequests.push(() => Promise.reject(new Error("host offline")));
		await expect(fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "play" })).rejects.toMatchObject({
			code: "unavailable", data: { outcome: "unknown" },
		});
		expect(fixture.native.state.failure).toEqual({ operation: "write" });
		expect(fixture.native.state.sections).toEqual(commandSections);
		expect(fixture.clientListeners.size).toBe(0);
		expect(fixture.native.failureListeners.size).toBe(0);
		expect(await fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "play" })).toMatchObject({
			bot: { id: "one", folderId: "play" },
		});
	});

	test("a rejected attempt followed by native retry success does not fail the command", async () => {
		const fixture = await nativeFixture();
		const held = heldRequest();
		fixture.native.state.hostRequests.push(() => Promise.reject(new Error("transient")), () => held.promise);
		let settled = false;
		const command = fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "play" });
		void command.then(() => { settled = true; }, () => { settled = true; });
		await fixture.native.waitForWrites(2);
		try {
			expect(fixture.native.state.writes).toHaveLength(2);
			expect(fixture.native.state.failure).toBeNull();
			expect(settled).toBe(false);
		} finally {
			held.resolve(fixture.native.state.writes[1]);
		}
		expect(await command).toMatchObject({ bot: { id: "one", folderId: "play" } });
	});

	test("local-only persistence requires a strict storage write and rejects its failure", async () => {
		const fixture = await nativeFixture(commandSections, commandRows, false);
		fixture.storage.fail = true;
		await expect(fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "play" })).rejects.toMatchObject({
			code: "unavailable", data: { outcome: "unknown" },
		});
		expect(fixture.storage.strictWrites).toContain(true);
		expect(fixture.native.state.persisted).toEqual(commandSections);
		expect(fixture.local.get(STORAGE_KEY)).toEqual(commandSections);
	});

	test("local-only persistence succeeds only after writing the durable local copy", async () => {
		const fixture = await nativeFixture(commandSections, commandRows, false);
		expect(await fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "play" })).toMatchObject({
			bot: { id: "one", folderId: "play" },
		});
		expect(fixture.storage.strictWrites).toContain(true);
		expect(fixture.local.get(STORAGE_KEY)).toEqual(fixture.native.state.sections);
	});

	test("supported host success tolerates a failed local mirror", async () => {
		const fixture = await nativeFixture();
		fixture.storage.fail = true;
		expect(await fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "play" })).toMatchObject({
			bot: { id: "one", folderId: "play" },
		});
		expect(fixture.native.state.sections?.[1]?.agentIds).toEqual(["three", "one"]);
		expect(fixture.storage.strictWrites).not.toContain(true);
	});

	test("client replacement during a held mutation rejects instead of reporting success on stale state", async () => {
		const fixture = await nativeFixture();
		const held = heldRequest();
		fixture.native.state.hostRequests.push(() => held.promise);
		const command = fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "play" });
		const completion = captureCommandOutcome(command);
		const replacement = fixture.makeClient([], commandRows);
		let outcome: CommandOutcome | undefined;
		try {
			await fixture.native.waitForWrites(1);
			fixture.setClient(replacement.client);
		} finally {
			held.resolve(fixture.native.state.writes[0]);
			await fixture.native.state.ops;
			outcome = await completion;
		}
		expect(outcome).toMatchObject({ status: "rejected", error: { code: "unavailable", data: { outcome: "unknown" } } });
		expect(replacement.state.sections).toEqual([]);
		expect(replacement.state.edits).toBe(0);
		expect(fixture.clientListeners.size).toBe(0);
	});

	test("queued UI A then B cannot confirm command A when only its owned writer fails", async () => {
		const fixture = await nativeFixture();
		const a = [
			{ id: "work", name: "Work", agentIds: ["two"] },
			{ id: "play", name: "Play", agentIds: ["three", "one"] },
			{ id: UNSECTIONED_ID, name: "", agentIds: [] },
		];
		const held = heldRequest();
		fixture.native.state.hostRequests.push(
			() => held.promise,
			(next) => Promise.resolve(next),
			() => Promise.reject(new Error("owned A failed")),
		);
		fixture.native.client.sidebarSections.edit(() => a);
		fixture.native.client.sidebarSections.edit(() => commandSections);
		const command = fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: "play" });
		const completion = captureCommandOutcome(command);
		let outcome: CommandOutcome | undefined;
		try {
			await fixture.native.waitForWrites(1);
			expect(fixture.native.state.edits).toBe(3);
		} finally {
			held.resolve(a);
			await fixture.native.state.ops;
			outcome = await completion;
		}
		expect(outcome).toMatchObject({ status: "rejected", error: { code: "unavailable", data: { outcome: "unknown" } } });
		expect(fixture.native.state.writes).toEqual([a, commandSections, a]);
		expect(fixture.native.state.sections).toEqual(commandSections);
		expect(fixture.native.state.persisted).toEqual(commandSections);
		expect(fixture.native.state.failure).toEqual({ operation: "write" });
		expect(fixture.clientListeners.size).toBe(0);
	});

	for (const target of ["play", null] as const) {
		test(`an optimistic manual ${target === null ? "unassignment" : "same-folder move"} cannot bypass the command's failed write`, async () => {
			const fixture = await nativeFixture();
			const manual = commandSections.map((section) => ({
				...section,
				agentIds: section.id === target
					? [...section.agentIds, "one"]
					: section.agentIds.filter((id) => id !== "one"),
			}));
			const held = heldRequest();
			fixture.native.state.hostRequests.push(
				() => held.promise,
				() => Promise.reject(new Error("owned confirmation failed")),
			);
			fixture.native.client.sidebarSections.edit(() => manual);
			const command = fixture.plugin.executeSidebar({ operation: "move-bot", bot: "one", folder: target });
			const completion = captureCommandOutcome(command);
			let outcome: CommandOutcome | undefined;
			try {
				await fixture.native.waitForWrites(1);
				expect(fixture.native.state.edits).toBe(2);
			} finally {
				held.resolve(manual);
				await fixture.native.state.ops;
				outcome = await completion;
			}
			expect(outcome).toMatchObject({ status: "rejected", error: { code: "unavailable", data: { outcome: "unknown" } } });
			expect(fixture.native.state.writes).toEqual([manual, manual]);
			expect(fixture.native.state.persisted).toEqual(manual);
			expect(fixture.native.state.sections).toEqual(manual);
			expect(fixture.native.state.failure).toEqual({ operation: "write" });
			expect(fixture.clientListeners.size).toBe(0);
		});
	}

	test("an earlier write of the same normalized empty singleton cannot confirm a failed last-folder deletion", async () => {
		const initial = [
			{ id: "work", name: "Work", agentIds: ["one"] },
			{ id: UNSECTIONED_ID, name: "", agentIds: [] },
		];
		const fixture = await nativeFixture(initial);
		const empty: readonly Section[] = [];
		fixture.native.state.normalize = (next) => next.some((section) => section.id !== UNSECTIONED_ID) ? next : empty;
		const held = heldRequest();
		fixture.native.state.hostRequests.push(
			() => held.promise,
			(next) => Promise.resolve(next),
			() => Promise.reject(new Error("owned empty failed")),
		);
		fixture.native.client.sidebarSections.edit(() => empty);
		fixture.native.client.sidebarSections.edit(() => initial);
		const command = fixture.plugin.executeSidebar({ operation: "delete-folder", folder: "work" });
		const completion = captureCommandOutcome(command);
		let outcome: CommandOutcome | undefined;
		try {
			await fixture.native.waitForWrites(1);
			expect(fixture.native.state.edits).toBe(3);
			expect(fixture.native.state.intent).toBe(empty);
		} finally {
			held.resolve(empty);
			await fixture.native.state.ops;
			outcome = await completion;
		}
		expect(outcome).toMatchObject({ status: "rejected", error: { code: "unavailable", data: { outcome: "unknown" } } });
		expect(fixture.native.state.writes[0]).toBe(empty);
		expect(fixture.native.state.writes[2]).toBe(empty);
		expect(fixture.native.state.sections).toEqual(initial);
		expect(fixture.native.state.writes).toHaveLength(3);
		expect(fixture.native.state.persisted).toEqual(initial);
		expect(fixture.native.state.failure).toEqual({ operation: "write" });
		expect(fixture.clientListeners.size).toBe(0);
	});

	const unavailableCases = [
		"missing client", "missing store", "missing roster", "loading roster", "restored roster",
		"unloaded sections", "edit no-op", "missing native ops", "missing native intent", "missing native phase", "missing native generation",
		"missing native create", "native create not ready",
		"duplicate folder IDs", "duplicate bot IDs", "missing roster rows",
	] as const;
	for (const reason of unavailableCases) {
		test(`rejects unavailable ${reason}`, async () => {
			const fixture = await nativeFixture();
			const { client, state } = fixture.native;
			let command: SidebarCommand = { operation: "move-bot", bot: "one", folder: "play" };
			switch (reason) {
				case "missing client": fixture.setClient(undefined); break;
				case "missing store": fixture.setClient({ roster: client.roster }); break;
				case "missing roster": fixture.setClient({ sidebarSections: client.sidebarSections }); break;
				case "loading roster": state.snapshot = { loadState: "loading", agents: { rows: commandRows } }; break;
				case "restored roster": state.snapshot = { loadState: "ready", isShowingRestoredRoster: true, agents: { rows: commandRows } }; break;
				case "unloaded sections": state.sections = null; break;
				case "duplicate folder IDs": state.sections = [...commandSections, { id: "work", name: "Duplicate", agentIds: [] }]; break;
				case "duplicate bot IDs": state.snapshot = { loadState: "ready", agents: { rows: [...commandRows, { id: "one", name: "Duplicate" }] } }; break;
				case "missing roster rows": state.snapshot = { loadState: "ready", agents: {} }; break;
				case "edit no-op": state.editNoop = true; break;
				case "missing native ops": fixture.setClient({ ...client, sidebarSections: { ...client.sidebarSections, ops: undefined } }); break;
				case "missing native intent": fixture.setClient({ ...client, sidebarSections: { ...client.sidebarSections, intent: undefined } }); break;
				case "missing native phase": fixture.setClient({ ...client, sidebarSections: { ...client.sidebarSections, phase: undefined } }); break;
				case "missing native generation": fixture.setClient({ ...client, sidebarSections: { ...client.sidebarSections, generation: undefined } }); break;
				case "missing native create":
					fixture.setClient({ ...client, sidebarSections: { ...client.sidebarSections, commands: undefined } });
					command = { operation: "create-folder", name: "New" };
					break;
				case "native create not ready":
					state.createId = null;
					command = { operation: "create-folder", name: "New" };
					break;
			}
			await expect(fixture.plugin.executeSidebar(command)).rejects.toMatchObject({ code: "unavailable" });
			expect(state.writes).toEqual([]);
			expect(fixture.clientListeners.size).toBe(0);
			expect(fixture.native.failureListeners.size).toBe(0);
		});
	}
});

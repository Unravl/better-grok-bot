import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createStorage } from "./storage.ts";
import { recordingLogger } from "./test/fakes.ts";

beforeAll(() => GlobalRegistrator.register({ url: "file:///data/current/renderer/index.html?bgb" }));
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => localStorage.clear());

function withFailingPersistence(error: Error, run: () => void): void {
	const storage = globalThis.localStorage;
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	// Happy DOM's Storage proxy hides method descriptors, so patching it cannot be undone.
	const failingStorage: Storage = {
		get length() {
			return storage.length;
		},
		getItem: storage.getItem.bind(storage),
		key: storage.key.bind(storage),
		setItem(): never {
			throw error;
		},
		removeItem(): never {
			throw error;
		},
		clear(): never {
			throw error;
		},
	};
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: failingStorage });
	try {
		run();
	} finally {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, "localStorage");
		else Object.defineProperty(globalThis, "localStorage", descriptor);
	}
}

describe("storage persistence", () => {
	test("strict writes persist JSON-roundtripped data and notify after the cache changes", () => {
		const log = recordingLogger();
		const storage = createStorage("sidebar-folders", log);
		const value = { folders: ["Research"], omitted: undefined, createdAt: new Date("2026-10-11T00:00:00.000Z") };
		const expected = { folders: ["Research"], createdAt: "2026-10-11T00:00:00.000Z" };
		const snapshots: unknown[] = [];
		const unsubscribe = storage.subscribe("folders", () => snapshots.push(storage.get("folders", null)));
		try {
			storage.set("folders", value, { requirePersistence: true });
			expect(localStorage.getItem("bgb:sidebar-folders:folders")).toBe(JSON.stringify(expected));
			const cached = storage.get<unknown>("folders", null);
			expect(cached).toEqual(expected);
			expect(snapshots).toEqual([expected]);
			expect(createStorage("sidebar-folders", log).get<unknown>("folders", null)).toEqual(expected);
		} finally {
			unsubscribe();
		}
	});

	test("strict JSON serialization errors leave persisted data, cache, and listeners unchanged", () => {
		const storage = createStorage("sidebar-folders", recordingLogger());
		storage.set("folders", { folders: ["Existing"] }, { requirePersistence: true });
		const previous = storage.get("folders", null);
		const persisted = localStorage.getItem("bgb:sidebar-folders:folders");
		const circular: { self?: unknown } = {};
		circular.self = circular;
		let notifications = 0;
		const unsubscribe = storage.subscribe("folders", () => notifications++);
		try {
			expect(() => storage.set("folders", circular, { requirePersistence: true })).toThrow(TypeError);
			expect(storage.get("folders", null)).toBe(previous);
			expect(localStorage.getItem("bgb:sidebar-folders:folders")).toBe(persisted);
			expect(notifications).toBe(0);
		} finally {
			unsubscribe();
		}
	});

	test.each([
		{ operation: "write", value: { folders: ["Rejected"] } },
		{ operation: "removal", value: undefined },
	])("strict localStorage $operation failures leave persisted data, cache, and listeners unchanged", ({ value }) => {
		const storage = createStorage("sidebar-folders", recordingLogger());
		storage.set("folders", { folders: ["Existing"] }, { requirePersistence: true });
		const previous = storage.get("folders", null);
		const persisted = localStorage.getItem("bgb:sidebar-folders:folders");
		const failure = new Error("quota exceeded");
		let notifications = 0;
		const unsubscribe = storage.subscribe("folders", () => notifications++);
		try {
			withFailingPersistence(failure, () => {
				expect(() => storage.set("folders", value, { requirePersistence: true })).toThrow(failure);
				expect(storage.get("folders", null)).toBe(previous);
				expect(localStorage.getItem("bgb:sidebar-folders:folders")).toBe(persisted);
				expect(notifications).toBe(0);
			});
		} finally {
			unsubscribe();
		}
	});

	test.each([
		{ operation: "writes", value: { folders: ["Session only"], omitted: undefined }, expected: { folders: ["Session only"] } },
		{ operation: "removals", value: undefined, expected: null },
	])("default $operation publish session-only state on persistence failure", ({ value, expected }) => {
		const log = recordingLogger();
		const storage = createStorage("sidebar-folders", log);
		const original = { folders: ["Persisted"] };
		storage.set("folders", original);
		const snapshots: unknown[] = [];
		const unsubscribe = storage.subscribe("folders", () => snapshots.push(storage.get("folders", null)));
		try {
			withFailingPersistence(new Error("quota exceeded"), () => {
				storage.set("folders", value);
				expect(storage.get<unknown>("folders", null)).toEqual(expected);
				expect(snapshots).toEqual([expected]);
				expect(snapshots[0]).toBe(storage.get("folders", null));
				expect(localStorage.getItem("bgb:sidebar-folders:folders")).toBe(JSON.stringify(original));
				expect(createStorage("sidebar-folders", log).get<unknown>("folders", null)).toEqual(original);
			});
		} finally {
			unsubscribe();
		}
	});
});

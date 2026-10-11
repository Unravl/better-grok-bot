import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BuildManifest, PluginContext, PluginServices, PluginStorage } from "../../sdk/index.ts";
import { createOutputDevice } from "./runtime.ts";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const PREFERENCE_KEY = "outputDeviceId";

function fakeStorage(): PluginStorage {
	const values = new Map<string, unknown>();
	const listeners = new Map<string, Set<() => void>>();
	return {
		get: <T>(key: string, fallback: T): T => (values.has(key) ? (values.get(key) as T) : fallback),
		set(key, value) {
			values.set(key, value);
			for (const listener of [...(listeners.get(key) ?? [])]) listener();
		},
		subscribe(key, listener) {
			const set = listeners.get(key) ?? new Set();
			listeners.set(key, set);
			set.add(listener);
			return () => set.delete(listener);
		},
	};
}

const manifest: BuildManifest = {
	bgbVersion: "0.1.0",
	buildFormat: 1,
	buildKey: "key",
	platform: "darwin",
	appVersion: "0.68.1",
	appFingerprint: "fingerprint",
	builtAt: "2026-01-01T00:00:00.000Z",
	plugins: [],
	themes: [],
};

/** An `<audio>` element whose `setSinkId` calls stay pending until the test settles them. */
function fakeSpeaker() {
	const element = document.createElement("audio");
	let sinkId = "";
	const requested: string[] = [];
	const pending: { resolve: () => void; reject: () => void }[] = [];
	Object.defineProperties(element, {
		sinkId: { get: () => sinkId },
		setSinkId: {
			value: (deviceId: string) =>
				new Promise<void>((resolve, reject) => {
					requested.push(deviceId);
					pending.push({
						resolve: () => {
							sinkId = deviceId;
							resolve();
						},
						reject: () => reject(new DOMException("Requested device not found", "NotFoundError")),
					});
				}),
		},
	});
	/** Settles the oldest pending switch, then drains the microtasks the runtime's switch chain reacts in. */
	const settle = async (outcome: "resolve" | "reject"): Promise<void> => {
		const next = pending.shift();
		if (next === undefined) throw new Error("no setSinkId call is pending");
		next[outcome]();
		for (let turn = 0; turn < 10; turn++) await Promise.resolve();
	};
	return { element, requested, pending, settle, sinkId: () => sinkId };
}

function setup() {
	const storage = fakeStorage();
	const services: PluginServices = {
		get keys(): never {
			throw new Error("output-device uses no keys service");
		},
		get media(): never {
			throw new Error("output-device uses no media service");
		},
		get mcp(): never {
			throw new Error("output-device uses no MCP service");
		},
	};
	const ctx: PluginContext = {
		id: "output-device",
		log: { info() {}, warn() {}, error() {} },
		storage,
		settings: {
			get: () => {
				throw new RangeError("output-device has no settings schema");
			},
			set: () => {},
			subscribe: () => () => {},
		},
		manifest,
		app: { React: undefined, jsx: undefined, ui: undefined, client: undefined, onClient: () => () => {} },
		services,
	};
	const plugin = createOutputDevice(ctx);
	const speaker = fakeSpeaker();
	plugin.trackMediaElement(speaker.element, "voice-preview");
	return { speaker, choose: (deviceId: string) => storage.set(PREFERENCE_KEY, deviceId) };
}

describe("output routing", () => {
	test("a choice made while a switch is in flight is applied once that switch settles", async () => {
		const { speaker, choose } = setup();
		choose("headset");
		choose("");
		// The default is still current, but the in-flight switch is about to leave it.
		expect(speaker.requested).toEqual(["headset"]);
		await speaker.settle("resolve");
		expect(speaker.requested).toEqual(["headset", ""]);
		await speaker.settle("resolve");
		expect(speaker.sinkId()).toBe("");
		expect(speaker.pending).toEqual([]);
	});

	test("switches on one sink never overlap and end on the latest choice", async () => {
		const { speaker, choose } = setup();
		choose("headset");
		choose("speakers");
		choose("headset");
		expect(speaker.pending.length).toBe(1);
		await speaker.settle("resolve");
		expect(speaker.requested).toEqual(["headset"]);
		expect(speaker.sinkId()).toBe("headset");
		expect(speaker.pending).toEqual([]);
	});

	test("a failing device falls back to the default once and stops when the default fails too", async () => {
		const { speaker, choose } = setup();
		choose("speakers");
		await speaker.settle("resolve");
		choose("headset");
		await speaker.settle("reject");
		expect(speaker.requested).toEqual(["speakers", "headset", ""]);
		await speaker.settle("reject");
		expect(speaker.requested).toEqual(["speakers", "headset", ""]);
		expect(speaker.pending).toEqual([]);
		expect(speaker.sinkId()).toBe("speakers");
	});

	test("a fallback started before a newer choice still ends on that choice", async () => {
		const { speaker, choose } = setup();
		choose("headset");
		choose("speakers");
		await speaker.settle("reject");
		// The failed headset needs no fallback: the newer choice is the next switch.
		expect(speaker.requested).toEqual(["headset", "speakers"]);
		await speaker.settle("resolve");
		expect(speaker.sinkId()).toBe("speakers");
		expect(speaker.pending).toEqual([]);
	});
});

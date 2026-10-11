import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BuildManifest, KeysService, MediaService, Platform, PluginContext, PluginStorage } from "../../sdk/index.ts";
import { createPushToTalk, duckLevel, focusedOnlyReason } from "./runtime.ts";

/** `performance.now()` as the runtime sees it; tests move it instead of waiting. */
let now = 0;

beforeAll(() => {
	GlobalRegistrator.register();
	spyOn(performance, "now").mockImplementation(() => now);
	// Grok Bot is in the background: presses come from the keys service.
	spyOn(document, "hasFocus").mockImplementation(() => false);
});
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => {
	now = 0;
});

/** Just over the minimum hold that gets an answer. */
const HOLD_MS = 230;
/** Past the release tail: the next microphone frame ends the turn (as when timers are throttled). */
const TAIL_MS = 200;

function fakeStorage(initial: Record<string, unknown> = {}): PluginStorage {
	const values = new Map<string, unknown>(Object.entries(initial));
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

/** A keys service that records watches and lets the test play the helper. */
function fakeKeys() {
	const watchers = new Map<string, Set<(down: boolean) => void>>();
	const chordListeners = new Set<(code: string) => void>();
	const service: KeysService = {
		state: "ready",
		detail: undefined,
		watch(code, listener) {
			const set = watchers.get(code) ?? new Set();
			watchers.set(code, set);
			set.add(listener);
			return () => set.delete(listener);
		},
		onChord(listener) {
			chordListeners.add(listener);
			return () => chordListeners.delete(listener);
		},
		install: async () => {},
		subscribe: () => () => {},
	};
	return {
		service,
		watched: (): string[] => [...watchers].filter(([, set]) => set.size > 0).map(([code]) => code),
		key(code: string, down: boolean): void {
			for (const listener of [...(watchers.get(code) ?? [])]) listener(down);
		},
		chord(code: string): void {
			for (const listener of [...chordListeners]) listener(code);
		},
	};
}

function fakeMedia() {
	const levels: number[] = [];
	const service: MediaService = { state: "ready", detail: undefined, duck: (level) => void levels.push(level), subscribe: () => () => {} };
	return { service, levels };
}

function manifest(platform: Platform): BuildManifest {
	return {
		bgbVersion: "0.1.0",
		buildFormat: 1,
		buildKey: "key",
		platform,
		appVersion: "0.68.1",
		appFingerprint: "fingerprint",
		builtAt: "2026-01-01T00:00:00.000Z",
		plugins: [],
		themes: [],
	};
}

/** A realtime session socket: an object the runtime accepts as a `WebSocket`, recording sent frames. */
function fakeSession() {
	const sent: { type: string }[] = [];
	const received: string[] = [];
	const listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
	const socket: WebSocket = Object.create(WebSocket.prototype);
	Object.defineProperties(socket, {
		readyState: { value: WebSocket.OPEN },
		send: { value: (data: string) => void sent.push(JSON.parse(data)) },
		addEventListener: {
			value: (type: string, listener: (event: { data: unknown }) => void) => {
				listeners.set(type, [...(listeners.get(type) ?? []), listener]);
			},
		},
	});
	const emit = (type: string, data?: unknown): void => {
		for (const listener of listeners.get(type) ?? []) listener({ data: data === undefined ? undefined : JSON.stringify(data) });
	};
	return { adapter: { socket, receive: (event: { type: string }) => void received.push(event.type) }, sent, received, emit };
}

function setup(platform: Platform = "darwin", stored: Record<string, unknown> = {}) {
	const keys = fakeKeys();
	const media = fakeMedia();
	const services = {
		keys: keys.service,
		media: media.service,
		get mcp(): never {
			throw new Error("push-to-talk uses no MCP service");
		},
	};
	const ctx: PluginContext = {
		id: "push-to-talk",
		log: { info() {}, warn() {}, error() {} },
		storage: fakeStorage(stored),
		settings: {
			get: () => {
				throw new RangeError("push-to-talk has no settings schema");
			},
			set: () => {},
			subscribe: () => () => {},
		},
		manifest: manifest(platform),
		app: { React: undefined, jsx: undefined, ui: undefined, client: undefined, onClient: () => () => {} },
		services,
	};
	const plugin = createPushToTalk(ctx);
	const session = fakeSession();
	/** Starts a voice call whose server confirmed manual turns. */
	const startCall = (): void => {
		plugin.attachSession(session.adapter);
		session.emit("message", { type: "session.updated", session: { turn_detection: { type: null } } });
	};
	return { plugin, keys, media, session, startCall };
}

describe("background key eligibility", () => {
	test("keys outside the watchable set work only while focused", () => {
		expect(focusedOnlyReason("KeyA", "win32")).toBe(
			"Works while Grok Bot is focused; holding it in the background needs a modifier, function or lock key",
		);
	});

	test("watchable keys a helper can't watch on this OS name the OS", () => {
		expect(focusedOnlyReason("F22", "darwin")).toBe("Works while Grok Bot is focused; this key can't be watched in the background on macOS");
		expect(focusedOnlyReason("Fn", "linux")).toBe("Works while Grok Bot is focused; this key can't be watched in the background on Linux");
	});

	test("helper keys on their OS are eligible", () => {
		expect(focusedOnlyReason("F22", "win32")).toBeNull();
		expect(focusedOnlyReason("AltRight", "linux")).toBeNull();
		expect(focusedOnlyReason("Fn", "darwin")).toBeNull();
	});
});

describe("background watch", () => {
	test("watches the binding only while a manual-turn push-to-talk call is live", () => {
		const { keys, session, startCall } = setup();
		expect(keys.watched()).toEqual([]);
		startCall();
		expect(keys.watched()).toEqual(["AltRight"]);
		session.emit("close");
		expect(keys.watched()).toEqual([]);
	});

	test("never watches a binding the helper can't watch on this OS", () => {
		const { keys, startCall } = setup("darwin", { key: "F22" });
		startCall();
		expect(keys.watched()).toEqual([]);
	});

	test("a call without push to talk watches nothing", () => {
		const { keys, plugin, session } = setup("win32", { enabled: false });
		plugin.attachSession(session.adapter);
		session.emit("message", { type: "session.updated", session: { turn_detection: { type: "server_vad" } } });
		expect(keys.watched()).toEqual([]);
	});
});

describe("background holds", () => {
	test("a background press starts a turn and a `false` from a dropped connection ends it like a release", () => {
		const { keys, plugin, session, startCall } = setup();
		startCall();
		keys.key("AltRight", true);
		expect(session.received).toEqual(["input_audio_buffer.speech_started"]);
		expect(plugin.holdsFrame(new Float32Array(480))).toBe(false);
		now = HOLD_MS;
		keys.key("AltRight", false);
		now += TAIL_MS;
		expect(plugin.holdsFrame(new Float32Array(480))).toBe(true);
		expect(session.received).toEqual(["input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped"]);
		expect(session.sent.map((frame) => frame.type)).toEqual(["input_audio_buffer.commit", "response.create"]);
	});

	test("a chord on a modifier binding discards the turn instead of answering it", () => {
		const { keys, plugin, session, startCall } = setup();
		startCall();
		keys.key("AltRight", true);
		plugin.holdsFrame(new Float32Array(480));
		now = HOLD_MS;
		keys.chord("AltRight");
		keys.key("AltRight", false);
		now += TAIL_MS;
		plugin.holdsFrame(new Float32Array(480));
		expect(session.sent.map((frame) => frame.type)).toEqual(["input_audio_buffer.clear"]);
		expect(session.received).toEqual(["input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped"]);
	});
});

describe("music ducking", () => {
	test("lowers music while the user holds the key, then to the Grok level until the reply is done", () => {
		const { keys, media, plugin, session, startCall } = setup("win32", { musicWhileUserTalks: 10, musicWhileGrokTalks: 30 });
		startCall();
		keys.key("AltRight", true);
		plugin.holdsFrame(new Float32Array(480));
		now = HOLD_MS;
		keys.key("AltRight", false);
		now += TAIL_MS;
		plugin.holdsFrame(new Float32Array(480));
		expect(media.levels).toEqual([0.1, 0.3]);
		session.emit("message", { type: "response.done" });
		expect(media.levels).toEqual([0.1, 0.3, 1]);
	});

	test("pressing again during the release tail returns to the user level until the turn is released again", () => {
		const { keys, media, plugin, session, startCall } = setup("win32", { musicWhileUserTalks: 30, musicWhileGrokTalks: 10 });
		startCall();
		keys.key("AltRight", true);
		plugin.holdsFrame(new Float32Array(480));
		now = HOLD_MS;
		keys.key("AltRight", false);
		expect(media.levels).toEqual([0.3, 0.1]);
		now += 50;
		keys.key("AltRight", true);
		expect(media.levels).toEqual([0.3, 0.1, 0.3]);
		now += HOLD_MS;
		keys.key("AltRight", false);
		now += TAIL_MS;
		plugin.holdsFrame(new Float32Array(480));
		expect(media.levels).toEqual([0.3, 0.1, 0.3, 0.1]);
		expect(session.sent.map((frame) => frame.type)).toEqual(["input_audio_buffer.commit", "response.create"]);
	});

	test("the duck level is the lowest active slider, and 1 when nobody talks", () => {
		expect(duckLevel({ userTalking: false, userPercent: 0, grokTalking: false, grokPercent: 20 })).toBe(1);
		expect(duckLevel({ userTalking: true, userPercent: 40, grokTalking: true, grokPercent: 20 })).toBe(0.2);
	});
});

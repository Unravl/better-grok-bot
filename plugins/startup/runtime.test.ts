import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BuildManifest, KeysService, MediaService, PluginContext, PluginStorage } from "../../sdk/index.ts";
import { createStartup } from "./runtime.ts";

beforeAll(() => {
	GlobalRegistrator.register();
	// Web Locks grant this window the launch: the callback runs with a lock.
	Object.defineProperty(navigator, "locks", {
		configurable: true,
		value: {
			request: (name: string, _options: unknown, callback: (lock: { name: string }) => unknown) =>
				Promise.resolve(callback({ name })),
		},
	});
});
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => sessionStorage.clear());

function fakeStorage(initial: Record<string, unknown>): PluginStorage {
	const values = new Map<string, unknown>(Object.entries(initial));
	return {
		get: <T>(key: string, fallback: T): T => (values.has(key) ? (values.get(key) as T) : fallback),
		set: (key, value) => void values.set(key, value),
		subscribe: () => () => {},
	};
}

/** A snapshot store counting its live subscribers. */
function store<T>(value: T) {
	let subscribers = 0;
	return {
		get: () => value,
		subscribe(): () => void {
			subscribers += 1;
			return () => {
				subscribers -= 1;
			};
		},
		subscribers: () => subscribers,
	};
}

function fakeClient(botId = "bot-1") {
	const auth = store({ status: { kind: "logged-in" } });
	const roster = store({ loadState: "ready", agents: { rows: [{ id: botId, name: "Ani" }] } });
	const voiceCall = store({ phase: "idle" });
	const focused: string[] = [];
	return {
		client: {
			auth: { snapshots: auth },
			roster: { snapshots: roster },
			voiceCall: { snapshots: voiceCall },
			desktopWindow: { ingestFocusAgent: (request: { id: string }) => void focused.push(request.id) },
		},
		subscribers: () => [auth.subscribers(), roster.subscribers(), voiceCall.subscribers()],
		focused,
	};
}

function setup(stored: Record<string, unknown> = {}) {
	let deliver: (client: unknown) => void = () => {
		throw new Error("startup never subscribed to app clients");
	};
	const warnings: string[] = [];
	const unavailable = (): never => {
		throw new Error("startup uses no services");
	};
	const services = {
		get keys(): KeysService {
			return unavailable();
		},
		get media(): MediaService {
			return unavailable();
		},
	};
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
	const ctx: PluginContext = {
		id: "startup",
		log: { info() {}, warn: (message: unknown) => void warnings.push(String(message)), error() {} },
		storage: fakeStorage(stored),
		settings: { get: () => false, set: () => {}, subscribe: () => () => {} },
		manifest,
		app: {
			React: undefined,
			jsx: undefined,
			ui: undefined,
			client: undefined,
			onClient(listener) {
				deliver = listener;
				return () => {};
			},
		},
		services,
	};
	const plugin = createStartup(ctx);
	return { plugin, deliver: (client: unknown) => deliver(client), warnings };
}

/**
 * Runs the plugin's queued `window.setTimeout(…, 0)` steps: a zero-delay timer queued after them
 * fires after them. (They are happy-dom's window timers, which Bun's fake timers don't drive.)
 */
function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	window.setTimeout(resolve, 0);
	return promise;
}

describe("app client handover", () => {
	test("follows each new client and drops the previous client's subscriptions", () => {
		const { deliver } = setup();
		const first = fakeClient();
		const second = fakeClient();
		deliver(first.client);
		expect(first.subscribers()).toEqual([1, 1, 1]);
		deliver(first.client);
		expect(first.subscribers()).toEqual([1, 1, 1]);
		deliver(second.client);
		expect(first.subscribers()).toEqual([0, 0, 0]);
		expect(second.subscribers()).toEqual([1, 1, 1]);
	});

	test("ignores a client without the expected shape and keeps the current one", () => {
		const { deliver, warnings } = setup();
		const current = fakeClient();
		deliver(current.client);
		deliver({ roster: {} });
		expect(current.subscribers()).toEqual([1, 1, 1]);
		expect(warnings).toHaveLength(1);
	});
});

describe("voice on startup", () => {
	test("presses the chosen bot's voice-call button once the client and its chat view are ready", async () => {
		const { plugin, deliver } = setup({ voiceBot: "bot-1" });
		const app = fakeClient("bot-1");
		const start = mock(() => {});
		deliver(app.client);
		plugin.offerVoiceCall("bot-0", undefined);
		await settle();
		expect(app.focused).toEqual(["bot-1"]);
		plugin.offerVoiceCall("bot-1", start);
		await settle();
		expect(start).toHaveBeenCalledTimes(1);
	});

	test("a reloaded window never starts a second call", async () => {
		const starts = [mock(() => {}), mock(() => {})];
		for (const start of starts) {
			const { plugin, deliver } = setup({ voiceBot: "bot-1" });
			deliver(fakeClient("bot-1").client);
			plugin.offerVoiceCall("bot-1", start);
			await settle();
		}
		expect(starts.map((start) => start.mock.calls.length)).toEqual([1, 0]);
	});
});

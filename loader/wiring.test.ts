import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AgentStatus } from "../sdk/index.ts";
import { createBridgeClient } from "./bridge-client.ts";
import { createServicesClient } from "./services.ts";
import { createLoaderStore } from "./store.ts";
import { createStyleManager } from "./styles.ts";
import { createFakeSockets, FakeClock, fakeGlobals, manifestWith, pluginStatus, recordingLogger, settle } from "./test/fakes.ts";
import { wireBridge } from "./wiring.ts";

beforeAll(() => GlobalRegistrator.register({ url: "file:///data/current/renderer/index.html?bgb" }));
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => {
	document.head.innerHTML = "";
});

const RUNNING_KEY = "a".repeat(64);

function agentStatus(): AgentStatus {
	return {
		bgbVersion: "0.1.0",
		platform: "darwin",
		app: { version: "0.68.1", path: "/Applications/Grok Bot.app" },
		build: { key: RUNNING_KEY, appVersion: "0.68.1", builtAt: "2026-10-11T00:00:00.000Z" },
		building: false,
		update: { state: "idle", current: "0.1.0" },
		settings: { openAtLogin: false, autoUpdate: true },
		plugins: [],
		themes: [],
		keys: { state: "ready" },
		media: { state: "ready" },
	};
}

function setup(devPlugin = false) {
	const fake = createFakeSockets();
	const clock = new FakeClock();
	const log = recordingLogger();
	const manifest = manifestWith(devPlugin ? [pluginStatus({ id: "mine", source: "dev" })] : [], { buildKey: RUNNING_KEY });
	const bridge = createBridgeClient({
		port: 39320,
		token: "t",
		buildKey: RUNNING_KEY,
		appVersion: "0.68.1",
		bgbVersion: "0.1.0",
		globals: fakeGlobals(fake.WebSocket),
		clock,
		log,
	});
	const services = createServicesClient(bridge, log);
	const store = createLoaderStore(RUNNING_KEY, clock, log);
	const styles = createStyleManager(document);
	let reloads = 0;
	const refreshStatus = async (): Promise<void> => {
		const status = await bridge.request("status.get", {});
		store.setStatus(status);
		services.applyStatus(status);
	};
	wireBridge({ bridge, store, services, styles, manifest, refreshStatus, reload: () => reloads++, log });
	bridge.start();
	return { ...fake, clock, bridge, services, store, styles, reloads: () => reloads };
}

const methods = (frames: Record<string, unknown>[]): unknown[] => frames.filter((frame) => frame.type === "req").map((frame) => frame.method);

describe("reconnect sequence", () => {
	test("after an agent restart: status, key union, duck level, themes, and the build-key check", async () => {
		const { last, clock, services, store } = setup();
		const first = last();
		first.accept();
		first.welcome(RUNNING_KEY);
		expect(methods(first.sent)).toEqual(["status.get", "keys.watch", "media.duck", "themes.styles"]);
		expect(store.getSnapshot().reloadPending).toBe(false);

		services.keysFor("push-to-talk").watch("AltRight", () => {});
		services.mediaFor("push-to-talk").duck(0.4);
		first.drop();
		clock.advance(1_000);
		const second = last();
		expect(second).not.toBe(first);
		second.accept();
		second.welcome("b".repeat(64));
		expect(methods(second.sent)).toEqual(["status.get", "keys.watch", "media.duck", "themes.styles"]);
		expect(second.lastRequest("keys.watch").params).toEqual({ codes: ["AltRight"] });
		expect(second.lastRequest("media.duck").params).toEqual({ level: 0.4 });
		expect(store.getSnapshot().reloadPending).toBe(true);

		second.reply(second.lastRequest("status.get"), agentStatus());
		second.reply(second.lastRequest("themes.styles"), { styles: [{ id: "dark", css: ":root{--x:1}" }] });
		await settle(() => document.querySelector('style[data-bgb-style="theme:dark"]') !== null && store.getSnapshot().status !== null);
		expect(store.getSnapshot().status?.settings.autoUpdate).toBe(true);
		expect(services.keysFor("push-to-talk").state).toBe("ready");
		expect(document.querySelector('style[data-bgb-style="theme:dark"]')?.textContent).toBe(":root{--x:1}");
	});

	test("live events: themes.changed replaces theme styles, build.finished with another key sets reloadPending", () => {
		const { last, store } = setup();
		const socket = last();
		socket.accept();
		socket.welcome(RUNNING_KEY);
		const plugin = document.createElement("style");
		plugin.dataset.bgbStyle = "plugin:startup";
		document.head.append(plugin);
		socket.event("themes.changed", { styles: [{ id: "one", css: "a{}" }] });
		socket.event("themes.changed", { styles: [{ id: "two", css: "b{}" }] });
		expect([...document.querySelectorAll("style[data-bgb-style]")].map((style) => style.getAttribute("data-bgb-style"))).toEqual([
			"plugin:startup",
			"theme:two",
		]);
		socket.event("build.started", {});
		expect(store.getSnapshot().building).toBe(true);
		socket.event("build.finished", { buildKey: "c".repeat(64), ok: true, appVersion: "0.68.1", failed: [] });
		expect(store.getSnapshot()).toMatchObject({ building: false, reloadPending: true });
		socket.event("build.finished", { buildKey: RUNNING_KEY, ok: true, appVersion: "0.68.1", failed: [] });
		expect(store.getSnapshot().reloadPending).toBe(false);
	});

	test("a themes.styles reply older than a later themes.changed is dropped", async () => {
		const { last } = setup();
		const socket = last();
		socket.accept();
		socket.welcome(RUNNING_KEY);
		const stale = socket.lastRequest("themes.styles");
		socket.event("themes.changed", { styles: [{ id: "new", css: "b{}" }] });
		socket.reply(stale, { styles: [{ id: "old", css: "a{}" }] });
		for (let round = 0; round < 50; round++) await Promise.resolve();
		expect([...document.querySelectorAll("style[data-bgb-style]")].map((style) => style.getAttribute("data-bgb-style"))).toEqual(["theme:new"]);
	});

	test("bridge.moving sets reloadPending; dev.reload reloads only pages with a dev plugin", () => {
		const plain = setup();
		plain.last().accept();
		plain.last().welcome(RUNNING_KEY);
		plain.last().event("dev.reload", {});
		expect(plain.reloads()).toBe(0);
		plain.last().event("bridge.moving", { port: 39321 });
		expect(plain.store.getSnapshot().reloadPending).toBe(true);

		const dev = setup(true);
		dev.last().accept();
		dev.last().welcome(RUNNING_KEY);
		dev.last().event("dev.reload", {});
		expect(dev.reloads()).toBe(1);
	});
});

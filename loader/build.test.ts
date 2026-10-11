import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BootPayload } from "../sdk/index.ts";
import { createFakeSockets, manifestWith, pluginStatus } from "./test/fakes.ts";

beforeAll(() => GlobalRegistrator.register({ url: "file:///data/current/renderer/index.html?bgb" }));
afterAll(() => GlobalRegistrator.unregister());

async function bundle(): Promise<string> {
	const result = await Bun.build({ entrypoints: [`${import.meta.dir}/index.ts`], target: "browser", format: "iife" });
	expect(result.logs.filter((entry) => entry.level === "error")).toEqual([]);
	expect(result.success).toBe(true);
	const [output] = result.outputs;
	if (output === undefined) throw new Error("no bundle output");
	return output.text();
}

describe("loader bundle", () => {
	test("builds as a browser IIFE without host APIs", async () => {
		const code = await bundle();
		expect(code.length).toBeGreaterThan(1_000);
		expect(code).not.toMatch(/\bBun\.|from "node:|require\("node:/);
	});

	test("boot.js installs BetterGrokBot, consumes the payload, injects styles and connects", async () => {
		const code = await bundle();
		const fake = createFakeSockets();
		const savedWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = fake.WebSocket;
		const payload: BootPayload = {
			manifest: manifestWith([pluginStatus({ id: "alpha", granted: [] })], { buildKey: "k".repeat(64) }),
			bridge: { port: 39444, token: "boot-token" },
			styles: [
				{ id: "alpha", kind: "plugin", css: ".alpha{}" },
				{ id: "dark", kind: "theme", css: ":root{--dark:1}" },
			],
		};
		globalThis.__BGB_BOOT__ = payload;
		try {
			new Function(code)();
			const runtime = globalThis.BetterGrokBot;
			expect(runtime?.version).toBe("0.1.0");
			expect(runtime?.manifest.plugins.map((plugin) => plugin.id)).toEqual(["alpha"]);
			expect(Object.isFrozen(runtime?.manifest.plugins[0])).toBe(true);
			expect("__BGB_BOOT__" in globalThis).toBe(false);
			expect([...document.querySelectorAll("style[data-bgb-style]")].map((style) => style.getAttribute("data-bgb-style"))).toEqual([
				"plugin:alpha",
				"theme:dark",
			]);
			const socket = fake.last();
			expect(socket.url).toBe("ws://127.0.0.1:39444/bgb");
			socket.accept();
			expect(socket.sent[0]).toMatchObject({ type: "hello", token: "boot-token", buildKey: "k".repeat(64) });
			expect(runtime?.bridgeState()).toBe("connecting");

			const script = document.createElement("script");
			script.dataset.bgbPlugin = "alpha";
			Object.defineProperty(document, "currentScript", { configurable: true, get: () => script });
			runtime?.define("alpha", () => ({ answer: () => 42 }));
			Reflect.deleteProperty(document, "currentScript");
			expect(runtime?.call("alpha", "answer")).toBe(42);
		} finally {
			globalThis.WebSocket = savedWebSocket;
			Reflect.deleteProperty(globalThis, "BetterGrokBot");
			Reflect.deleteProperty(globalThis, "__BGB_BOOT__");
		}
	});
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SidebarError, type BootPayload, type SidebarCommand, type SidebarResult } from "../sdk/index.ts";
import { boot } from "./boot.ts";
import { createFakeSockets, FakeClock, manifestWith, pluginStatus, settle } from "./test/fakes.ts";

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

	test("boot binds only the loaded sidebar-folders export and preserves asynchronous failures", async () => {
		const fake = createFakeSockets();
		const clock = new FakeClock();
		const savedWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = fake.WebSocket;
		globalThis.__BGB_BOOT__ = {
			manifest: manifestWith([pluginStatus({ id: "alpha" }), pluginStatus({ id: "sidebar-folders" })]),
			bridge: { port: 39444, token: "boot-token" },
			styles: [],
		};
		let unrelatedCalls = 0;
		let sidebarCalls = 0;
		try {
			const runtime = boot({ clock });
			if (!runtime) throw new Error("runtime did not boot");
			const socket = fake.last();
			socket.accept();
			expect(socket.sent[0]).toMatchObject({ capabilities: ["sidebar-folders"] });
			socket.welcome();
			const script = document.createElement("script");
			Object.defineProperty(document, "currentScript", { configurable: true, get: () => script });
			script.dataset.bgbPlugin = "alpha";
			runtime.define("alpha", () => ({
				executeSidebar: async () => {
					unrelatedCalls++;
					return { operation: "list-folders", folders: [] };
				},
			}));
			socket.receive({ type: "sidebar.req", id: 1, command: { operation: "list-folders" } });
			await settle(() => socket.sent.some((frame) => frame.type === "sidebar.res" && frame.id === 1));
			expect(socket.sent.at(-1)).toMatchObject({ id: 1, ok: false, error: { code: "unavailable" } });
			script.dataset.bgbPlugin = "sidebar-folders";
			runtime.define("sidebar-folders", () => ({
				executeSidebar: async (command: SidebarCommand): Promise<SidebarResult> => {
					sidebarCalls++;
					await Promise.resolve();
					if (command.operation === "delete-folder") throw new SidebarError("permission-denied", "Cannot delete Unassigned", { folder: "__agents__" });
					return { operation: "list-folders", folders: [{ id: "work", name: "Work", botIds: ["bot-1"] }] };
				},
			}));
			Reflect.deleteProperty(document, "currentScript");
			socket.receive({ type: "sidebar.req", id: 2, command: { operation: "list-folders" } });
			socket.receive({ type: "sidebar.req", id: 3, command: { operation: "delete-folder", folder: "__agents__" } });
			await settle(() => socket.sent.filter((frame) => frame.type === "sidebar.res").length === 3);
			expect(socket.sent.find((frame) => frame.type === "sidebar.res" && frame.id === 2)).toEqual({
				type: "sidebar.res", id: 2, ok: true,
				result: { operation: "list-folders", folders: [{ id: "work", name: "Work", botIds: ["bot-1"] }] },
			});
			expect(socket.sent.find((frame) => frame.type === "sidebar.res" && frame.id === 3)).toEqual({
				type: "sidebar.res", id: 3, ok: false,
				error: { code: "permission-denied", message: "Cannot delete Unassigned", data: { folder: "__agents__" } },
			});
			expect(unrelatedCalls).toBe(0);
			expect(sidebarCalls).toBe(2);
		} finally {
			fake.last().drop();
			globalThis.WebSocket = savedWebSocket;
			Reflect.deleteProperty(document, "currentScript");
			Reflect.deleteProperty(globalThis, "BetterGrokBot");
			Reflect.deleteProperty(globalThis, "__BGB_BOOT__");
		}
	});
});

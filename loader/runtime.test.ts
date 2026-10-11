import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PermissionError, SidebarError, type PluginContext, type PluginStatus, type ReactComponentInstance, type SettingField, type SidebarCommand, type SidebarResult } from "../sdk/index.ts";
import { createBoundary, NullComponent } from "./boundary.ts";
import { BridgeRequestError, offlineBridgeClient } from "./bridge-client.ts";
import { createHookRegistry } from "./hooks.ts";
import { createRuntime } from "./runtime.ts";
import { createServicesClient } from "./services.ts";
import { createFakeReact, manifestWith, pluginStatus, recordingLogger } from "./test/fakes.ts";

beforeAll(() => GlobalRegistrator.register({ url: "file:///data/current/renderer/index.html?bgb" }));
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => localStorage.clear());

function setup(plugins: PluginStatus[]) {
	const log = recordingLogger();
	let currentScript: string | undefined;
	const hooks = createHookRegistry({ log, createSection: () => () => null });
	const { runtime, settingsFor, executeSidebar } = createRuntime({
		manifest: manifestWith(plugins),
		hooks,
		services: createServicesClient(offlineBridgeClient(), log),
		bridgeState: () => "disconnected",
		currentScriptPlugin: () => currentScript,
		log,
	});
	/** Runs `fn` as if from `<script data-bgb-plugin="<id>">`. */
	const fromScript = (id: string | undefined, fn: () => void): void => {
		currentScript = id;
		try {
			fn();
		} finally {
			currentScript = undefined;
		}
	};
	return { runtime, hooks, log, fromScript, settingsFor, executeSidebar };
}

describe("define", () => {
	test("accepts only an active plugin defined from its own script", () => {
		const { runtime, fromScript, log } = setup([pluginStatus({ id: "alpha" }), pluginStatus({ id: "beta" })]);
		fromScript("beta", () => runtime.define("alpha", () => ({ hello: () => "alpha" })));
		expect(runtime.call("alpha", "hello")).toBeUndefined();
		expect(log.lines.some((line) => line.includes('ignoring define() for plugin "alpha"'))).toBe(true);
		fromScript("alpha", () => runtime.define("alpha", () => ({ hello: () => "alpha" })));
		expect(runtime.call("alpha", "hello")).toBe("alpha");
	});

	test("binds to document.currentScript's data-bgb-plugin", () => {
		const log = recordingLogger();
		const { runtime } = createRuntime({
			manifest: manifestWith([pluginStatus({ id: "alpha" })]),
			hooks: createHookRegistry({ log, createSection: () => () => null }),
			services: createServicesClient(offlineBridgeClient(), log),
			bridgeState: () => "disconnected",
			currentScriptPlugin: () => document.currentScript?.dataset.bgbPlugin,
			log,
		});
		const script = document.createElement("script");
		script.dataset.bgbPlugin = "intruder";
		Object.defineProperty(document, "currentScript", { configurable: true, get: () => script });
		try {
			runtime.define("alpha", () => ({ value: () => 1 }));
			expect(runtime.call("alpha", "value")).toBeUndefined();
			script.dataset.bgbPlugin = "alpha";
			runtime.define("alpha", () => ({ value: () => 1 }));
			expect(runtime.call("alpha", "value")).toBe(1);
		} finally {
			Reflect.deleteProperty(document, "currentScript");
		}
	});

	test("ignores plugins that are not active", () => {
		const { runtime, fromScript } = setup([pluginStatus({ id: "off", state: "disabled" })]);
		fromScript("off", () => runtime.define("off", () => ({ f: () => 1 })));
		expect(runtime.call("off", "f")).toBeUndefined();
	});

	test("status() overlays a runtime failure only on the entry that ran, not on an invalid duplicate of its id", () => {
		const { runtime, fromScript } = setup([
			pluginStatus({ id: "push-to-talk", source: "bundled" }),
			pluginStatus({ id: "push-to-talk", source: "community", state: "invalid", errors: ['id "push-to-talk" is reserved'] }),
		]);
		fromScript("push-to-talk", () =>
			runtime.define("push-to-talk", () => {
				throw new Error("cannot start");
			}),
		);
		expect(runtime.status().map((status) => [status.source, status.state])).toEqual([
			["bundled", "runtime-failed"],
			["community", "invalid"],
		]);
	});

	test("a bundled plugin listed before an invalid duplicate of its id is defined", () => {
		const { runtime, fromScript } = setup([
			pluginStatus({ id: "push-to-talk", source: "bundled" }),
			pluginStatus({ id: "push-to-talk", source: "community", state: "invalid", errors: ['id "push-to-talk" is reserved'] }),
		]);
		fromScript("push-to-talk", () => runtime.define("push-to-talk", () => ({ ping: () => "bundled" })));
		expect(runtime.call("push-to-talk", "ping")).toBe("bundled");
		expect(runtime.status().map((status) => [status.source, status.state])).toEqual([
			["bundled", "active"],
			["community", "invalid"],
		]);
	});
});

describe("services", () => {
	test("throw PermissionError without a grant", () => {
		const { runtime, fromScript } = setup([
			pluginStatus({ id: "granted", permissions: ["keys", "media"], granted: ["keys"] }),
		]);
		let ctx: PluginContext | undefined;
		fromScript("granted", () =>
			runtime.define("granted", (context) => {
				ctx = context;
				return {};
			}),
		);
		expect(ctx?.services.keys.state).toBe("error");
		expect(() => ctx?.services.media).toThrow(PermissionError);
		expect(() => ctx?.services.media).toThrow("plugin granted lacks permission media");
	});

	test("MCP access without its grant throws PermissionError with plugin and permission metadata", () => {
		const { runtime, fromScript } = setup([
			pluginStatus({ id: "ungranted", permissions: ["mcp"], granted: [] }),
		]);
		let ctx: PluginContext | undefined;
		fromScript("ungranted", () =>
			runtime.define("ungranted", (context) => {
				ctx = context;
				return {};
			}),
		);
		expect(ctx).toBeDefined();
		let failure: unknown;
		try {
			void ctx!.services.mcp;
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(PermissionError);
		expect(failure).toMatchObject({
			pluginId: "ungranted",
			permission: "mcp",
			message: "plugin ungranted lacks permission mcp",
		});
	});

	test("granted MCP access reaches the service and rejects list while the bridge is disconnected", async () => {
		const { runtime, fromScript } = setup([
			pluginStatus({ id: "granted", permissions: ["mcp"], granted: ["mcp"] }),
		]);
		let ctx: PluginContext | undefined;
		fromScript("granted", () =>
			runtime.define("granted", (context) => {
				ctx = context;
				return {};
			}),
		);
		expect(ctx).toBeDefined();
		const failure = await ctx!.services.mcp.list().catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(BridgeRequestError);
		expect(failure).toMatchObject({ code: "unavailable" });
	});
});

describe("call", () => {
	test("never throws", () => {
		const { runtime, fromScript } = setup([pluginStatus({ id: "alpha" })]);
		fromScript("alpha", () =>
			runtime.define("alpha", () => ({
				boom: () => {
					throw new Error("boom");
				},
				notFunction: 42,
			})),
		);
		expect(runtime.call("alpha", "boom")).toBeUndefined();
		expect(runtime.call("alpha", "notFunction")).toBeUndefined();
		expect(runtime.call("alpha", "missing")).toBeUndefined();
		expect(runtime.call("unknown", "fn")).toBeUndefined();
	});

	test("status() overlays runtime-failed when a runtime throws", () => {
		const { runtime, fromScript } = setup([pluginStatus({ id: "alpha" })]);
		fromScript("alpha", () =>
			runtime.define("alpha", () => {
				throw new Error("cannot start");
			}),
		);
		const [status] = runtime.status();
		expect(status?.state).toBe("runtime-failed");
		expect(status?.errors).toEqual(["runtime threw: cannot start"]);
		expect(runtime.manifest.plugins[0]?.state).toBe("active");
	});
});

describe("executeSidebar", () => {
	const command: SidebarCommand = { operation: "list-folders" };
	const result: SidebarResult = { operation: "list-folders", folders: [{ id: "folder-1", name: "Work", botIds: ["bot-1"] }] };

	test("awaits the own handler defined by the active sidebar plugin and passes the parsed command", async () => {
		const { runtime, fromScript, executeSidebar } = setup([pluginStatus({ id: "sidebar-folders" })]);
		let received: unknown;
		fromScript("sidebar-folders", () => runtime.define("sidebar-folders", () => ({
			executeSidebar: async (value: SidebarCommand) => {
				await Promise.resolve();
				received = value;
				return result;
			},
		})));
		expect(await executeSidebar(command)).toBe(result);
		expect(received).toEqual(command);
		expect(received).not.toBe(command);
	});

	test("propagates the exact native asynchronous rejection", async () => {
		const { runtime, fromScript, executeSidebar } = setup([pluginStatus({ id: "sidebar-folders" })]);
		const failure = new Error("native sidebar failed");
		fromScript("sidebar-folders", () => runtime.define("sidebar-folders", () => ({
			executeSidebar: async () => {
				await Promise.resolve();
				throw failure;
			},
		})));
		expect(await executeSidebar(command).catch((error: unknown) => error)).toBe(failure);
	});

	test("never dispatches to arbitrary plugins or accepts their definition of the sidebar", async () => {
		const { runtime, fromScript, executeSidebar } = setup([
			pluginStatus({ id: "alpha" }),
			pluginStatus({ id: "sidebar-folders" }),
		]);
		let calls = 0;
		const handler = () => {
			calls++;
			return result;
		};
		fromScript("alpha", () => {
			runtime.define("alpha", () => ({ executeSidebar: handler }));
			runtime.define("sidebar-folders", () => ({ executeSidebar: handler }));
		});
		await expect(executeSidebar(command)).rejects.toMatchObject({ code: "unavailable" });
		expect(calls).toBe(0);
	});

	for (const state of ["missing", "not-loaded", "disabled", "runtime-failed", "missing-export", "inherited-export", "non-function-export"] as const) {
		test(`rejects unavailable sidebar state: ${state}`, async () => {
			const plugins = state === "missing" ? [] : [pluginStatus({
				id: "sidebar-folders",
				state: state === "disabled" ? "disabled" : "active",
			})];
			const { runtime, fromScript, executeSidebar } = setup(plugins);
			let calls = 0;
			const handler = () => {
				calls++;
				return result;
			};
			if (state !== "missing" && state !== "not-loaded") {
				fromScript("sidebar-folders", () => runtime.define("sidebar-folders", () => {
					if (state === "runtime-failed") throw new Error("factory failed");
					if (state === "missing-export") return {};
					if (state === "inherited-export") {
						const exports: Record<string, unknown> = {};
						Object.setPrototypeOf(exports, { executeSidebar: handler });
						return exports;
					}
					return { executeSidebar: state === "non-function-export" ? 42 : handler };
				}));
			}
			const failure = await executeSidebar(command).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(SidebarError);
			expect(failure).toMatchObject({ code: "unavailable" });
			expect(calls).toBe(0);
		});
	}

	const invalidResults: unknown[] = [
		undefined,
		null,
		{ operation: "list-folders", folders: [{ id: "", name: "Work", botIds: [] }] },
		{ operation: "list-folders", folders: [], extra: true },
		{ operation: "list-bots", bots: [] },
	];
	for (const [index, invalidResult] of invalidResults.entries()) {
		test(`rejects invalid or mismatched handler result ${index}`, async () => {
			const { runtime, fromScript, executeSidebar } = setup([pluginStatus({ id: "sidebar-folders" })]);
			fromScript("sidebar-folders", () => runtime.define("sidebar-folders", () => ({
				executeSidebar: async () => invalidResult,
			})));
			const failure = await executeSidebar(command).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(SidebarError);
			expect(failure).toMatchObject({ code: "internal" });
		});
	}

	test("rejects malformed commands before invoking the plugin", async () => {
		const { runtime, fromScript, executeSidebar } = setup([pluginStatus({ id: "sidebar-folders" })]);
		let calls = 0;
		fromScript("sidebar-folders", () => runtime.define("sidebar-folders", () => ({
			executeSidebar: () => {
				calls++;
				return result;
			},
		})));
		const malformedCommands: unknown[] = [
			null,
			{ operation: "arbitrary-export" },
			{ operation: "list-folders", pluginId: "alpha" },
			{ operation: "create-folder", name: " " },
			{ operation: "move-bot", bot: "bot-1" },
		];
		for (const malformed of malformedCommands) {
			const failure = await executeSidebar(malformed as SidebarCommand).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(SidebarError);
			expect(failure).toMatchObject({ code: "bad-request" });
		}
		expect(calls).toBe(0);
	});
});

describe("component", () => {
	test("the boundary renders null after a throw, for every instance", () => {
		const React = createFakeReact();
		const log = recordingLogger();
		const jsx = (type: unknown, props: Record<string, unknown>) => React.createElement(type, props);
		const Boundary = createBoundary(React, jsx, () => "inner", "BetterGrokBot(test.Comp)", log) as {
			new (props: Record<string, unknown>): ReactComponentInstance & { render(): unknown; componentDidCatch(error: unknown): void };
			getDerivedStateFromError(): unknown;
		};
		const before = new Boundary({ a: 1 });
		expect(before.render()).toMatchObject({ props: { a: 1 } });
		Boundary.getDerivedStateFromError();
		before.componentDidCatch(new Error("render failed"));
		expect(before.render()).toBeNull();
		expect(new Boundary({}).render()).toBeNull();
		expect(log.lines.filter((line) => line.includes("crashed"))).toHaveLength(1);
	});

	test("defaults React and jsx to the core React and wraps the factory's component", () => {
		const { runtime, fromScript, hooks } = setup([pluginStatus({ id: "alpha" })]);
		expect(runtime.component("alpha", "Widget")).toBe(NullComponent);
		hooks.provideReact(createFakeReact());
		fromScript("alpha", () => runtime.define("alpha", () => ({ Widget: () => () => "widget" })));
		const component = runtime.component("alpha", "Widget");
		expect(component).not.toBe(NullComponent);
		expect(runtime.component("alpha", "Widget")).toBe(component);
		expect(runtime.component("alpha", "Missing")).toBe(NullComponent);
	});
});

describe("settings", () => {
	const fields: Record<string, SettingField> = {
		enabled: { type: "boolean", label: "Enabled", default: true },
		level: { type: "number", label: "Level", default: 50, min: 0, max: 100 },
		mode: {
			type: "select",
			label: "Mode",
			default: "auto",
			options: [
				{ value: "auto", label: "Auto" },
				{ value: "manual", label: "Manual" },
			],
		},
	};

	test("get falls back to the default for wrong types, out-of-range numbers and unknown options", () => {
		const { settingsFor } = setup([]);
		const settings = settingsFor("alpha", fields);
		localStorage.setItem("bgb:alpha:setting:enabled", JSON.stringify("yes"));
		localStorage.setItem("bgb:alpha:setting:level", JSON.stringify(150));
		localStorage.setItem("bgb:alpha:setting:mode", JSON.stringify("turbo"));
		expect(settings.get("enabled")).toBe(true);
		expect(settings.get("level")).toBe(50);
		expect(settings.get("mode")).toBe("auto");
	});

	test("set stores valid values under setting:<name> and notifies; invalid values and unknown keys throw RangeError", () => {
		const { settingsFor } = setup([]);
		const settings = settingsFor("alpha", fields);
		let notified = 0;
		settings.subscribe("level", () => notified++);
		settings.set("level", 80);
		expect(settings.get("level")).toBe(80);
		expect(localStorage.getItem("bgb:alpha:setting:level")).toBe("80");
		expect(notified).toBe(1);
		expect(() => settings.set("enabled", "yes")).toThrow(RangeError);
		expect(() => settings.set("level", 101)).toThrow(RangeError);
		expect(() => settings.set("mode", "turbo")).toThrow(RangeError);
		expect(() => settings.set("unknown", true)).toThrow(RangeError);
		expect(() => settings.get("unknown")).toThrow(RangeError);
	});

	test("a newer schema gets its own settings object over the same storage; the loaded one is unchanged", () => {
		const { settingsFor } = setup([]);
		const { level: _added, ...older } = fields;
		const loaded = settingsFor("alpha", older);
		const newer = settingsFor("alpha", fields);
		expect(newer).not.toBe(loaded);
		expect(settingsFor("alpha", { ...older })).toBe(loaded);
		newer.set("enabled", false);
		expect(loaded.get("enabled")).toBe(false);
		expect(newer.get("level")).toBe(50);
		expect(() => loaded.get("level")).toThrow(RangeError);
	});

	test("ctx.settings and ctx.storage use the plugin's bgb: namespace", () => {
		const { runtime, fromScript } = setup([pluginStatus({ id: "alpha", settings: fields })]);
		let ctx: PluginContext | undefined;
		fromScript("alpha", () =>
			runtime.define("alpha", (context) => {
				ctx = context;
				return {};
			}),
		);
		ctx?.settings.set("mode", "manual");
		ctx?.storage.set("seen", { count: 1 });
		expect(localStorage.getItem("bgb:alpha:setting:mode")).toBe('"manual"');
		expect(localStorage.getItem("bgb:alpha:seen")).toBe('{"count":1}');
	});
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PermissionError, type PluginContext, type PluginStatus, type ReactComponentInstance, type SettingField } from "../sdk/index.ts";
import { createBoundary, NullComponent } from "./boundary.ts";
import { offlineBridgeClient } from "./bridge-client.ts";
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
	const { runtime, settingsFor } = createRuntime({
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
	return { runtime, hooks, log, fromScript, settingsFor };
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

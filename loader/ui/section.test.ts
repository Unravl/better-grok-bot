import { describe, expect, test } from "bun:test";
import type { AgentStatus, BridgeMethod, UiPrimitives } from "../../sdk/index.ts";
import { createSettings } from "../settings.ts";
import { createLoaderStore, DISCONNECT_RELOAD_MS } from "../store.ts";
import { createFakeReact, elements, FakeClock, manifestWith, pluginStatus, recordingLogger, type FakeElement } from "../test/fakes.ts";
import { createBgbSection } from "./section.ts";

const ui: UiPrimitives = { Section: "Section", Row: "Row", Toggle: "Toggle", Select: "Select", Button: "Button", textStyles: { body2: { font: "b2" } } };
const RUNNING_KEY = "a".repeat(64);

function memoryStorage() {
	const values = new Map<string, unknown>();
	return {
		get: <T>(key: string, fallback: T): T => (values.has(key) ? (values.get(key) as T) : fallback),
		set: (key: string, value: unknown) => {
			values.set(key, value);
		},
		subscribe: () => () => {},
	};
}

function setup() {
	const clock = new FakeClock();
	const log = recordingLogger();
	const store = createLoaderStore(RUNNING_KEY, clock, log);
	const requests: { method: BridgeMethod; params: unknown }[] = [];
	let reloads = 0;
	const manifest = manifestWith(
		[
			pluginStatus({ id: "push-to-talk", name: "Push to talk", settings: { key: { type: "key", label: "Key", default: "AltRight" } } }),
			pluginStatus({ id: "community-one", name: "Community One", source: "community" }),
		],
		{ buildKey: RUNNING_KEY, themes: [{ id: "dark", name: "Dark", enabled: false, valid: true }] },
	);
	const Section = createBgbSection(createFakeReact(), {
		store,
		request: async (method, params) => {
			requests.push({ method, params });
			throw new Error("not under test");
		},
		refreshStatus: async () => {},
		manifest,
		localStatus: () => [],
		settingsFor: (id, fields) => createSettings(id, fields, memoryStorage()),
		reload: () => reloads++,
		confirm: () => true,
		log,
	});
	const render = (): FakeElement[] => elements(Section({ ui }));
	return { clock, store, render, requests, reloads: () => reloads };
}

const reloadButton = (tree: FakeElement[]): FakeElement | undefined =>
	tree.find((element) => element.type === "Button" && element.props.children === "Reload to apply");

/** Every control in the section except "Reload to apply". */
function otherControls(tree: FakeElement[]): FakeElement[] {
	return tree.filter(
		(element) =>
			(element.type === "Toggle" || element.type === "Button" || element.type === "Select" || typeof element.type === "function") &&
			element !== reloadButton(tree),
	);
}

const isDisabled = (element: FakeElement): boolean => element.props.isDisabled === true || element.props.disabled === true;

function agentStatus(): AgentStatus {
	return {
		bgbVersion: "0.1.0",
		platform: "darwin",
		app: null,
		build: null,
		building: false,
		update: { state: "available", current: "0.1.0", latest: "0.2.0" },
		settings: { openAtLogin: true, autoUpdate: false },
		plugins: [pluginStatus({ id: "push-to-talk", name: "Push to talk" })],
		themes: [],
		keys: { state: "ready" },
		media: { state: "ready" },
	};
}

describe("settings section", () => {
	test("'Reload to apply' appears after 10 s of disconnect and stays enabled; every other control is disabled", () => {
		const { clock, store, render, reloads } = setup();
		store.setBridgeState("connecting");
		expect(reloadButton(render())).toBeUndefined();
		clock.advance(DISCONNECT_RELOAD_MS - 1);
		expect(reloadButton(render())).toBeUndefined();
		clock.advance(1);
		const tree = render();
		const button = reloadButton(tree);
		expect(button).toBeDefined();
		expect(button !== undefined && isDisabled(button)).toBe(false);
		const others = otherControls(tree);
		expect(others.length).toBeGreaterThan(5);
		expect(others.filter((element) => !isDisabled(element))).toEqual([]);

		store.setBridgeState("disconnected");
		clock.advance(60_000);
		const later = reloadButton(render());
		expect(later !== undefined && isDisabled(later)).toBe(false);
		(later?.props.onClick as () => void)();
		expect(reloads()).toBe(1);
	});

	test("connected: controls enable, the reload button waits for a newer build, and a drop restarts the 10 s clock", () => {
		const { clock, store, render } = setup();
		clock.advance(DISCONNECT_RELOAD_MS);
		store.setBridgeState("connected");
		store.setStatus(agentStatus());
		let tree = render();
		expect(reloadButton(tree)).toBeUndefined();
		const toggles = tree.filter((element) => element.type === "Toggle");
		expect(toggles.find((toggle) => toggle.props.label === "Open Grok Bot at login")?.props).toMatchObject({ isChecked: true, isDisabled: false });
		expect(tree.some((element) => element.type === "Button" && element.props.children === "Update to 0.2.0" && !isDisabled(element))).toBe(true);

		store.setCurrentBuildKey("b".repeat(64));
		expect(reloadButton(render())).toBeDefined();
		store.setCurrentBuildKey(RUNNING_KEY);
		expect(reloadButton(render())).toBeUndefined();

		store.setBridgeState("disconnected");
		clock.advance(DISCONNECT_RELOAD_MS - 1);
		expect(reloadButton(render())).toBeUndefined();
		clock.advance(1);
		tree = render();
		expect(reloadButton(tree)).toBeDefined();
	});

	test("rows: status, both settings toggles, plugins (community gets Update/Uninstall), install, themes, folders", () => {
		const { store, render } = setup();
		store.setBridgeState("connected");
		const tree = render();
		const section = tree[0];
		expect(section?.type).toBe("Section");
		expect(section?.props.title).toBe("Better Grok Bot");
		const labels = tree.filter((element) => element.type === "Row").map((row) => row.props.label);
		expect(labels).toEqual([
			"Better Grok Bot 0.1.0",
			"Open Grok Bot at login",
			"Install Better Grok Bot updates automatically",
			"Push to talk",
			"Community One · community",
			"Dark",
			"Open folder",
		]);
		const buttons = tree.filter((element) => element.type === "Button").map((button) => button.props.children);
		expect(buttons).toEqual(["Update", "Uninstall", "Plugins", "Themes", "Logs"]);
		const button = tree.find((element) => element.type === "Button");
		expect(button?.props).toMatchObject({ size: "md", type: "button", variant: "secondary", style: { font: "b2" } });
		const fieldRows = tree.filter((element) => typeof element.type === "function");
		expect(fieldRows.map((element) => element.key)).toEqual(["setting:push-to-talk:key", "install"]);
	});

	test("plugin toggles call plugins.setEnabled; theme toggles call themes.setEnabled", async () => {
		const { store, render, requests } = setup();
		store.setBridgeState("connected");
		const tree = render();
		const toggles = tree.filter((element) => element.type === "Toggle");
		(toggles.find((toggle) => toggle.props.label === "Push to talk")?.props.onToggle as (next: unknown) => void)(false);
		(toggles.find((toggle) => toggle.props.label === "Dark")?.props.onToggle as (next: unknown) => void)(true);
		expect(requests).toEqual([
			{ method: "plugins.setEnabled", params: { id: "push-to-talk", enabled: false } },
			{ method: "themes.setEnabled", params: { id: "dark", enabled: true } },
		]);
	});
});

import { describe, expect, test } from "bun:test";
import type { McpServerConfig, McpServerStatus, McpService, PluginContext, ReactLike } from "@better-grok-bot/sdk";
import { createSettings } from "./settings.ts";

interface Element {
	type: unknown;
	props: Record<string, unknown>;
}

interface SettingsHarness {
	render(): Element[];
	settle(): Promise<void>;
	field(label: string, value: string): void;
	click(label: string): void;
	submit(): Promise<void>;
	saved: McpServerConfig[];
	connected: string[];
	removed: string[];
	fail(message: string): void;
}

function elements(value: unknown): Element[] {
	if (Array.isArray(value)) return value.flatMap(elements);
	if (value === null || typeof value !== "object" || !("props" in value)) return [];
	const element = value as Element;
	return [element, ...elements(element.props.children)];
}

function harness(initial: McpServerConfig[] = []): SettingsHarness {
	let statuses: McpServerStatus[] = initial.map((config) => ({ config, state: "disconnected", toolCount: 0 }));
	const saved: McpServerConfig[] = [];
	const connected: string[] = [];
	const removed: string[] = [];
	let failure: string | undefined;
	const service: McpService = {
		list: async () => statuses,
		save: async (config) => {
			if (failure) throw new Error(failure);
			saved.push(config);
			statuses = [...statuses.filter((entry) => entry.config.id !== config.id), { config, state: "disconnected", toolCount: 0 }];
		},
		remove: async (id) => { removed.push(id); statuses = statuses.filter((entry) => entry.config.id !== id); },
		connect: async (id) => {
			connected.push(id);
			const server = statuses.find((entry) => entry.config.id === id);
			if (!server) throw new Error("Missing server");
			return { ...server, state: "connected", toolCount: 3 };
		},
		tools: async () => [],
		call: async () => ({ content: [] }),
	};
	const states: unknown[] = [];
	const refs: { current: unknown }[] = [];
	let stateIndex = 0;
	let refIndex = 0;
	let effectInstalled = false;
	const react = {
		useState(initialValue: unknown) {
			const index = stateIndex++;
			if (!(index in states)) states[index] = typeof initialValue === "function" ? (initialValue as () => unknown)() : initialValue;
			return [states[index], (next: unknown) => { states[index] = typeof next === "function" ? (next as (previous: unknown) => unknown)(states[index]) : next; }];
		},
		useRef(initialValue: unknown) {
			const index = refIndex++;
			refs[index] ??= { current: initialValue };
			return refs[index];
		},
		useEffect(effect: () => unknown) { if (!effectInstalled) { effectInstalled = true; effect(); } },
	} as unknown as ReactLike;
	const Component = createSettings({ React: react, jsx: (type, props) => ({ type, props }) }, { services: { mcp: service } } as unknown as PluginContext);
	const render = (): Element[] => { stateIndex = 0; refIndex = 0; return elements(Component({})); };
	const settle = async (): Promise<void> => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
	const field = (label: string, value: string): void => {
		const wrapper = render().find((element) => element.type === "label" && elements(element.props.children).some((child) => child.type === "span" && child.props.children === label));
		const input = elements(wrapper?.props.children).find((element) => element.type === "input" || element.type === "textarea" || element.type === "select");
		if (!input) throw new Error(`Missing field ${label}`);
		(input.props.onChange as (event: unknown) => void)({ currentTarget: { value } });
	};
	const click = (label: string): void => {
		const button = render().find((element) => element.type === "button" && element.props.children === label);
		if (!button) throw new Error(`Missing button ${label}`);
		(button.props.onClick as () => void)();
	};
	const submit = async (): Promise<void> => {
		const form = render().find((element) => element.type === "form");
		(form?.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
		await settle();
	};
	return { render, settle, field, click, submit, saved, connected, removed, fail: (message: string) => { failure = message; } };
}

const stdio: McpServerConfig = { id: "local", name: "Local", enabled: false, transport: "stdio", command: "server", args: [], env: {} };

async function ready(initial: McpServerConfig[] = []) {
	const ui = harness(initial);
	ui.render();
	await ui.settle();
	return ui;
}

function alert(ui: SettingsHarness): unknown {
	return ui.render().find((element) => element.props.role === "alert")?.props.children;
}

describe("Voice MCP settings", () => {
	test("saves parsed stdio configuration disabled by default", async () => {
		const ui = await ready();
		ui.field("Server name", "Local");
		ui.field("Command", "server");
		ui.field("Arguments (JSON array of strings)", '["--port", "123"]');
		ui.field("Environment (JSON object of string values)", '{"TOKEN":"secret"}');
		ui.field("Working directory (optional)", "/tmp/mcp");
		await ui.submit();
		expect(ui.saved[0]).toMatchObject({ name: "Local", enabled: false, transport: "stdio", command: "server", args: ["--port", "123"], env: { TOKEN: "secret" }, cwd: "/tmp/mcp" });
	});

	for (const [label, value] of [
		["Arguments (JSON array of strings)", "{}"],
		["Arguments (JSON array of strings)", "[1]"],
		["Arguments (JSON array of strings)", "not JSON"],
		["Environment (JSON object of string values)", "[]"],
		["Environment (JSON object of string values)", "null"],
		["Environment (JSON object of string values)", '{"TOKEN":1}'],
	]) {
		test(`rejects invalid ${label}: ${value}`, async () => {
			const ui = await ready();
			ui.field("Server name", "Local");
			ui.field("Command", "server");
			ui.field(label as string, value as string);
			await ui.submit();
			expect(ui.saved).toHaveLength(0);
			expect(alert(ui)).toBeTruthy();
		});
	}

	for (const transport of ["http", "sse"]) {
		test(`saves ${transport} URL and parsed headers`, async () => {
			const ui = await ready();
			ui.field("Server name", "Remote");
			ui.field("Transport", transport);
			ui.field("Server URL", "https://example.com/mcp");
			ui.field("Headers (JSON object of string values)", '{"Authorization":"Bearer token"}');
			await ui.submit();
			expect(ui.saved[0]).toMatchObject({ transport, enabled: false, url: "https://example.com/mcp", headers: { Authorization: "Bearer token" } });
		});
	}

	test("rejects non-string headers and non-HTTP URLs", async () => {
		const ui = await ready();
		ui.field("Server name", "Remote");
		ui.field("Transport", "http");
		ui.field("Server URL", "https://example.com/mcp");
		ui.field("Headers (JSON object of string values)", '{"Authorization":false}');
		await ui.submit();
		expect(ui.saved).toHaveLength(0);
		expect(alert(ui)).toContain("Headers");
		ui.field("Headers (JSON object of string values)", "{}");
		ui.field("Server URL", "file:///tmp/mcp");
		await ui.submit();
		expect(ui.saved).toHaveLength(0);
		expect(alert(ui)).toContain("HTTP or HTTPS");
	});

	test("editing preserves enabled state and ID", async () => {
		const ui = await ready([{ ...stdio, enabled: true }]);
		ui.click("Edit Local");
		ui.field("Server name", "Renamed");
		await ui.submit();
		expect(ui.saved[0]).toMatchObject({ id: "local", name: "Renamed", enabled: true });
	});

	test("tests a disabled server without saving or enabling it", async () => {
		const ui = await ready([stdio]);
		ui.click("Test connection to Local");
		await ui.settle();
		expect(ui.connected).toEqual(["local"]);
		expect(ui.saved).toHaveLength(0);
		expect(ui.render().find((element) => element.type === "input" && element.props.type === "checkbox")?.props.checked).toBe(false);
		expect(ui.render().some((element) => typeof element.props.children === "string" && element.props.children.includes("connected · 3 tools"))).toBe(true);
	});

	test("explicit enabling survives subsequent edits", async () => {
		const ui = await ready([stdio]);
		ui.click("Edit Local");
		const checkbox = ui.render().find((element) => element.type === "input" && element.props.type === "checkbox");
		(checkbox?.props.onChange as (event: unknown) => void)({ currentTarget: { checked: true } });
		await ui.settle();
		await ui.submit();
		expect(ui.saved.map((config) => config.enabled)).toEqual([true, true]);
	});

	test("save errors remain accessible and preserve draft inputs", async () => {
		const ui = await ready();
		ui.field("Server name", "Local");
		ui.field("Command", "server");
		ui.fail("Host unavailable");
		await ui.submit();
		expect(alert(ui)).toBe("Host unavailable");
		expect(ui.render().some((element) => element.type === "input" && element.props.value === "server")).toBe(true);
		expect(ui.render().find((element) => element.type === "section")?.props["aria-busy"]).toBe(false);
	});

	test("removing an edited server clears the editor and list", async () => {
		const ui = await ready([stdio]);
		ui.click("Edit Local");
		ui.click("Remove Local");
		await ui.settle();
		expect(ui.removed).toEqual(["local"]);
		expect(ui.render().some((element) => element.type === "legend" && element.props.children === "Add MCP server (disabled by default)")).toBe(true);
		expect(ui.render().some((element) => element.props.children === "No saved MCP servers.")).toBe(true);
	});
});

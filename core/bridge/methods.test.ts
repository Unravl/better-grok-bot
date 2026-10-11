import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AgentStatus, type BridgeMethod, type McpServerConfig, type McpServerStatus, type McpService, type McpTool, type McpToolResult, type PluginStatus, type SidebarCommand, SidebarError, type SidebarResult } from "../../sdk/index.ts";
import { type FakePlatform, fakePlatform, tempContext } from "../agent/testing.ts";
import { mutateConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { createMethodHandlers, type MethodDeps } from "./methods.ts";
import type { MethodHandlers, RendererConnection } from "./server.ts";

const SERVER: McpServerConfig = {
	id: "peer",
	name: "Loopback peer",
	enabled: false,
	transport: "http",
	url: "http://127.0.0.1:12345/mcp",
	headers: { Authorization: "Bearer configured-secret" },
};
const SERVER_STATUS: McpServerStatus = { config: SERVER, state: "connected", toolCount: 1 };
const TOOL: McpTool = { serverId: "peer", name: "echo", description: "Echo", inputSchema: { type: "object" } };
const RESULT: McpToolResult = { content: [{ type: "text", text: "failure" }], structuredContent: { ok: false }, isError: true };
const CONNECTION: RendererConnection = {
	id: 1,
	buildKey: "test-build",
	appVersion: "1.0.0",
	bgbVersion: "1.0.0",
	connectedAt: "2026-01-01T00:00:00.000Z",
};
const SIDEBAR_CONNECTION: RendererConnection = { ...CONNECTION, capabilities: ["sidebar-folders"] };
const OTHER_CONNECTION: RendererConnection = { ...SIDEBAR_CONNECTION, id: 2, buildKey: "other-build" };
const CLI_CONNECTION: RendererConnection = { ...CONNECTION, id: 100, buildKey: "cli" };
const SIDEBAR_RESULT: SidebarResult = { operation: "list-folders", folders: [{ id: "folder-1", name: "Work", botIds: ["bot-1"] }] };

type McpMethod = Extract<BridgeMethod, `mcp.${string}`>;
interface Invocation {
	method: McpMethod;
	args: unknown[];
}
const PARAMS: Record<McpMethod, Record<string, unknown>> = {
	"mcp.list": { pluginId: "voice" },
	"mcp.save": { pluginId: "voice", server: SERVER },
	"mcp.remove": { pluginId: "voice", id: "peer" },
	"mcp.connect": { pluginId: "voice", id: "peer" },
	"mcp.tools": { pluginId: "voice" },
	"mcp.call": { pluginId: "voice", serverId: "peer", name: "echo", arguments: { text: "hello" } },
};
const METHODS = Object.keys(PARAMS) as McpMethod[];

let ctx: CoreContext & { cleanup(): Promise<void> };
let plugins: PluginStatus[];
let calls: Invocation[];
let handlers: MethodHandlers;
let statusReads: number;
let platform: FakePlatform;
let renderers: RendererConnection[];
let sidebarCalls: { connectionId: number; command: SidebarCommand }[];
let sidebarResult: SidebarResult;

function plugin(overrides: Partial<PluginStatus> = {}): PluginStatus {
	return {
		id: "voice",
		name: "Voice",
		description: "Test consumer",
		version: "1.0.0",
		authors: [],
		source: "bundled",
		state: "active",
		errors: [],
		patches: [],
		permissions: ["mcp"],
		granted: ["mcp"],
		settings: {},
		hasRuntime: true,
		...overrides,
	};
}

function status(): AgentStatus {
	return {
		bgbVersion: "1.0.0",
		platform: "linux",
		app: null,
		build: null,
		building: false,
		update: { state: "idle", current: "1.0.0" },
		settings: { openAtLogin: false, autoUpdate: false },
		plugins,
		themes: [],
		keys: { state: "unsupported" },
		media: { state: "unsupported" },
	};
}

function recordingMcp(): McpService {
	return {
		async list() {
			calls.push({ method: "mcp.list", args: [] });
			return [SERVER_STATUS];
		},
		async save(server) {
			calls.push({ method: "mcp.save", args: [server] });
		},
		async remove(id) {
			calls.push({ method: "mcp.remove", args: [id] });
		},
		async connect(id) {
			calls.push({ method: "mcp.connect", args: [id] });
			return SERVER_STATUS;
		},
		async tools() {
			calls.push({ method: "mcp.tools", args: [] });
			return [TOOL];
		},
		async call(serverId, name, args, context) {
			calls.push({ method: "mcp.call", args: [serverId, name, args, context] });
			return RESULT;
		},
	};
}

function recordingSidebar(): MethodDeps["sidebar"] {
	return {
		renderers: () => renderers,
		async requestSidebar(connectionId, command) {
			sidebarCalls.push({ connectionId, command });
			return sidebarResult;
		},
	};
}

function create(mcp: McpService = recordingMcp(), sidebar: MethodDeps["sidebar"] = recordingSidebar()): MethodHandlers {
	const unexpected = async (): Promise<never> => { throw new Error("unexpected dependency"); };
	const deps: MethodDeps = {
		ctx,
		mcp,
		sidebar,
		ops: {
			inspectSource: unexpected,
			installInspected: unexpected,
			uninstallPlugin: unexpected,
			updatePlugin: unexpected,
			listThemes: unexpected,
			themeStyles: unexpected,
		},
		async status() {
			statusReads++;
			return status();
		},
		configChanged: unexpected,
		pluginsChanged() { throw new Error("unexpected pluginsChanged"); },
		rebuild() { throw new Error("unexpected rebuild"); },
		services: {
			watchKeys() { throw new Error("unexpected watchKeys"); },
			duck() { throw new Error("unexpected duck"); },
			install: unexpected,
		},
		checkUpdate: unexpected,
		applyUpdate: unexpected,
	};
	return createMethodHandlers(deps);
}

async function invoke(method: McpMethod, params: Record<string, unknown> = PARAMS[method], connection: RendererConnection = CONNECTION): Promise<unknown> {
	const handler = handlers[method];
	if (!handler) throw new Error(`missing handler ${method}`);
	return handler(params, connection);
}

async function executeSidebar(params: Record<string, unknown> = { command: { operation: "list-folders" } }, connection: RendererConnection = SIDEBAR_CONNECTION): Promise<unknown> {
	const handler = handlers["sidebar.execute"];
	if (!handler) throw new Error("missing handler sidebar.execute");
	return handler(params, connection);
}

async function deniedAll(): Promise<void> {
	for (const method of METHODS) await expect(invoke(method)).rejects.toMatchObject({ code: "permission-denied" });
	expect(calls).toEqual([]);
}

beforeEach(async () => {
	platform = fakePlatform("linux");
	ctx = await tempContext(platform);
	plugins = [plugin()];
	calls = [];
	statusReads = 0;
	renderers = [SIDEBAR_CONNECTION];
	sidebarCalls = [];
	sidebarResult = SIDEBAR_RESULT;
	handlers = create();
});

afterEach(async () => {
	await ctx.cleanup();
});

test("a missing plugin cannot use any MCP method", async () => {
	plugins = [];
	await deniedAll();
});

for (const state of ["disabled", "patch-failed", "runtime-failed", "invalid", "unsupported-platform"] as const) {
	test(`${state} plugins cannot use any MCP method`, async () => {
		plugins = [plugin({ state })];
		await deniedAll();
	});
}

test("fresh disabledPlugins immediately revokes every method even while build status remains active", async () => {
	expect(await invoke("mcp.list")).toEqual({ servers: [SERVER_STATUS] });
	calls.length = 0;
	await mutateConfig(ctx.paths, (config) => { config.disabledPlugins = ["voice"]; });
	await deniedAll();
	await mutateConfig(ctx.paths, (config) => { config.disabledPlugins = []; });
	expect(await invoke("mcp.list")).toEqual({ servers: [SERVER_STATUS] });
});

for (const source of ["core", "bundled"] as const) {
	test(`${source} authorization requires both declared mcp and current granted mcp`, async () => {
		await mutateConfig(ctx.paths, (config) => { config.grants.voice = ["mcp"]; });
		plugins = [plugin({ source, granted: [] })];
		await deniedAll();
		plugins = [plugin({ source, permissions: [], granted: ["mcp"] })];
		await deniedAll();
		plugins = [plugin({ source })];
		for (const method of METHODS) await invoke(method);
		expect(calls).toHaveLength(6);
	});
}

for (const source of ["community", "dev"] as const) {
	test(`${source} authorization intersects fresh config grants with declared permissions instead of stale status grants`, async () => {
		plugins = [plugin({ source, granted: ["mcp"] })];
		await deniedAll();
		await mutateConfig(ctx.paths, (config) => { config.grants.voice = ["mcp"]; });
		plugins = [plugin({ source, granted: [] })];
		for (const method of METHODS) await invoke(method);
		expect(calls).toHaveLength(6);
		calls.length = 0;
		plugins = [plugin({ source, permissions: [] })];
		await deniedAll();
		plugins = [plugin({ source })];
		await mutateConfig(ctx.paths, (config) => { config.grants.voice = []; });
		await deniedAll();
	});
}

test("authorization rereads status and follows the caller pluginId, not a cached connection/build privilege", async () => {
	await invoke("mcp.list");
	calls.length = 0;
	plugins = [plugin({ granted: [] }), plugin({ id: "other", permissions: [], granted: [] })];
	await deniedAll();
	await expect(invoke("mcp.list", { pluginId: "other" })).rejects.toMatchObject({ code: "permission-denied" });
	expect(calls).toEqual([]);
	expect(statusReads).toBe(8);
});

test("each MCP method rejects missing, empty, or non-string pluginId before touching the service", async () => {
	for (const method of METHODS) {
		for (const pluginId of [undefined, null, "", 1, [], {}]) {
			await expect(invoke(method, { ...PARAMS[method], pluginId })).rejects.toMatchObject({ code: "bad-request" });
		}
	}
	expect(calls).toEqual([]);
});

test("remove/connect/call validate server and tool identifiers", async () => {
	for (const method of ["mcp.remove", "mcp.connect"] as const) {
		for (const id of [undefined, null, "", 1, [], {}]) {
			await expect(invoke(method, { ...PARAMS[method], id })).rejects.toMatchObject({ code: "bad-request" });
		}
	}
	for (const field of ["serverId", "name"] as const) {
		for (const value of [undefined, null, "", 1, [], {}]) {
			await expect(invoke("mcp.call", { ...PARAMS["mcp.call"], [field]: value })).rejects.toMatchObject({ code: "bad-request" });
		}
	}
	expect(calls).toEqual([]);
});

test("tool arguments must be an object before touching the service", async () => {
	for (const args of [undefined, null, [], "text", 42, true]) {
		await expect(invoke("mcp.call", { ...PARAMS["mcp.call"], arguments: args })).rejects.toMatchObject({ code: "bad-request" });
	}
	expect(calls).toEqual([]);
});

test("save validates complete server config before delegating", async () => {
	const invalid: unknown[] = [
		undefined, null, [], "server", {},
		{ ...SERVER, id: "" },
		{ ...SERVER, id: "../outside" },
		{ ...SERVER, id: "x".repeat(65) },
		{ ...SERVER, name: "" },
		{ ...SERVER, name: "   " },
		{ ...SERVER, enabled: "true" },
		{ ...SERVER, transport: "websocket" },
		{ ...SERVER, url: "not a URL" },
		{ ...SERVER, url: "file:///tmp/mcp" },
		{ ...SERVER, url: "ftp://example.test/mcp" },
		{ ...SERVER, url: "https://user:password@example.test/mcp" },
		{ ...SERVER, url: "https://example.test/mcp#fragment" },
		{ ...SERVER, headers: [] },
		{ ...SERVER, headers: { Authorization: 1 } },
		{ ...SERVER, shell: true },
		{ id: "stdio", name: "stdio", enabled: false, transport: "stdio", command: "", args: [], env: {} },
		{ id: "stdio", name: "stdio", enabled: false, transport: "stdio", command: "mcp", args: [1], env: {} },
		{ id: "stdio", name: "stdio", enabled: false, transport: "stdio", command: "mcp", args: [], env: { KEY: false } },
		{ id: "stdio", name: "stdio", enabled: false, transport: "stdio", command: "mcp", args: [], env: {}, cwd: 1 },
	];
	for (const server of invalid) {
		await expect(invoke("mcp.save", { pluginId: "voice", server })).rejects.toMatchObject({ code: "bad-request" });
	}
	expect(calls).toEqual([]);
});

test("mcp.call forwards the authenticated connection as the fourth service argument", async () => {
	expect(await invoke("mcp.call")).toBe(RESULT);
	expect(calls).toEqual([{
		method: "mcp.call",
		args: ["peer", "echo", { text: "hello" }, { rendererConnectionId: CONNECTION.id }],
	}]);
});

test("model tool arguments and raw params cannot override the authenticated MCP origin", async () => {
	const args = {
		text: "hello",
		rendererConnectionId: OTHER_CONNECTION.id,
		context: { rendererConnectionId: OTHER_CONNECTION.id },
		_meta: { "io.github.unravl.bgb/rendererConnectionId": OTHER_CONNECTION.id },
	};
	for (const connection of [CONNECTION, CLI_CONNECTION]) {
		expect(await invoke("mcp.call", { ...PARAMS["mcp.call"], arguments: args, rendererConnectionId: OTHER_CONNECTION.id }, connection)).toBe(RESULT);
	}
	expect(calls).toEqual([CONNECTION, CLI_CONNECTION].map((connection) => ({
		method: "mcp.call",
		args: ["peer", "echo", args, { rendererConnectionId: connection.id }],
	})));
	expect(calls[0]?.args[2]).toBe(args);
	expect(calls[1]?.args[2]).toBe(args);
});

describe("sidebar.execute", () => {
	beforeEach(() => {
		plugins = [plugin({ id: "sidebar-folders", name: "Sidebar Folders", permissions: [], granted: [] })];
	});

	test("a direct renderer owns its connection even when another capable renderer is listed first", async () => {
		renderers = [OTHER_CONNECTION, SIDEBAR_CONNECTION];
		expect(await executeSidebar()).toBe(SIDEBAR_RESULT);
		expect(await executeSidebar({ command: { operation: "list-folders" }, rendererConnectionId: SIDEBAR_CONNECTION.id })).toBe(SIDEBAR_RESULT);
		expect(sidebarCalls).toEqual([
			{ connectionId: SIDEBAR_CONNECTION.id, command: { operation: "list-folders" } },
			{ connectionId: SIDEBAR_CONNECTION.id, command: { operation: "list-folders" } },
		]);
	});

	test("a direct renderer cannot override its own connection ID", async () => {
		renderers = [SIDEBAR_CONNECTION, OTHER_CONNECTION];
		await expect(executeSidebar({ command: { operation: "list-folders" }, rendererConnectionId: OTHER_CONNECTION.id })).rejects.toMatchObject({ code: "permission-denied" });
		expect(sidebarCalls).toEqual([]);
	});

	test("a direct renderer cannot fall back to another renderer when its own connection is gone or incapable", async () => {
		for (const current of [[OTHER_CONNECTION], [CONNECTION, OTHER_CONNECTION]]) {
			renderers = current;
			await expect(executeSidebar()).rejects.toMatchObject({ code: "unavailable" });
		}
		expect(sidebarCalls).toEqual([]);
	});

	test("a CLI call honors its explicit target among multiple capable renderers", async () => {
		renderers = [OTHER_CONNECTION, SIDEBAR_CONNECTION];
		for (const target of [SIDEBAR_CONNECTION, OTHER_CONNECTION]) {
			expect(await executeSidebar({ command: { operation: "list-folders" }, rendererConnectionId: target.id }, CLI_CONNECTION)).toBe(SIDEBAR_RESULT);
		}
		expect(sidebarCalls).toEqual([
			{ connectionId: SIDEBAR_CONNECTION.id, command: { operation: "list-folders" } },
			{ connectionId: OTHER_CONNECTION.id, command: { operation: "list-folders" } },
		]);
	});

	test("a CLI explicit target must be connected, non-CLI and capable", async () => {
		const oldRenderer: RendererConnection = { ...CONNECTION, id: 3 };
		const capableCli: RendererConnection = { ...CLI_CONNECTION, capabilities: ["sidebar-folders"] };
		renderers = [SIDEBAR_CONNECTION, oldRenderer, capableCli];
		for (const rendererConnectionId of [oldRenderer.id, capableCli.id, Number.MAX_SAFE_INTEGER]) {
			await expect(executeSidebar({ command: { operation: "list-folders" }, rendererConnectionId }, CLI_CONNECTION)).rejects.toMatchObject({ code: "unavailable" });
		}
		expect(sidebarCalls).toEqual([]);
	});

	test("a CLI call without context selects the sole capable non-CLI renderer, excluding old renderers and capable CLI clients", async () => {
		renderers = [
			{ ...CLI_CONNECTION, capabilities: ["sidebar-folders"] },
			{ ...CONNECTION, id: 3 },
			SIDEBAR_CONNECTION,
		];
		expect(await executeSidebar({ command: { operation: "list-folders" } }, CLI_CONNECTION)).toBe(SIDEBAR_RESULT);
		expect(sidebarCalls).toEqual([{ connectionId: SIDEBAR_CONNECTION.id, command: { operation: "list-folders" } }]);
	});

	test("a CLI call without a capable non-CLI renderer is unavailable", async () => {
		const inventories: RendererConnection[][] = [
			[],
			[CONNECTION],
			[{ ...CONNECTION, capabilities: [] }],
			[{ ...CLI_CONNECTION, capabilities: ["sidebar-folders"] }],
		];
		for (const inventory of inventories) {
			renderers = inventory;
			await expect(executeSidebar({ command: { operation: "list-folders" } }, CLI_CONNECTION)).rejects.toMatchObject({ code: "unavailable" });
		}
		expect(sidebarCalls).toEqual([]);
	});

	test("multiple capable renderers return conflict with candidates instead of choosing the first", async () => {
		renderers = [
			{ ...CLI_CONNECTION, capabilities: ["sidebar-folders"] },
			{ ...CONNECTION, id: 3 },
			OTHER_CONNECTION,
			SIDEBAR_CONNECTION,
		];
		await expect(executeSidebar({ command: { operation: "list-folders" } }, CLI_CONNECTION)).rejects.toMatchObject({
			code: "conflict",
			data: { candidates: [OTHER_CONNECTION, SIDEBAR_CONNECTION] },
		});
		expect(sidebarCalls).toEqual([]);
	});

	test("target selection reads the live renderer inventory on every invocation", async () => {
		await executeSidebar({ command: { operation: "list-folders" } }, CLI_CONNECTION);
		renderers = [OTHER_CONNECTION];
		await executeSidebar({ command: { operation: "list-folders" } }, CLI_CONNECTION);
		renderers = [];
		await expect(executeSidebar({ command: { operation: "list-folders" } }, CLI_CONNECTION)).rejects.toMatchObject({ code: "unavailable" });
		expect(sidebarCalls).toEqual([
			{ connectionId: SIDEBAR_CONNECTION.id, command: { operation: "list-folders" } },
			{ connectionId: OTHER_CONNECTION.id, command: { operation: "list-folders" } },
		]);
	});

	test("fresh config disables operations immediately while plugin status remains active, then allows re-enabling", async () => {
		await executeSidebar();
		sidebarCalls.length = 0;
		await mutateConfig(ctx.paths, (config) => { config.disabledPlugins = ["sidebar-folders"]; });
		await expect(executeSidebar()).rejects.toMatchObject({ code: "permission-denied" });
		expect(sidebarCalls).toEqual([]);
		await mutateConfig(ctx.paths, (config) => { config.disabledPlugins = []; });
		expect(await executeSidebar()).toBe(SIDEBAR_RESULT);
		expect(sidebarCalls).toEqual([{ connectionId: SIDEBAR_CONNECTION.id, command: { operation: "list-folders" } }]);
		expect(statusReads).toBe(3);
	});

	test("fresh status blocks missing and inactive plugins, including a newly patch-failed build", async () => {
		await executeSidebar();
		sidebarCalls.length = 0;
		plugins = [];
		await expect(executeSidebar()).rejects.toMatchObject({ code: "permission-denied" });
		for (const state of ["disabled", "patch-failed", "runtime-failed", "invalid", "unsupported-platform"] as const) {
			plugins = [plugin({ id: "sidebar-folders", state })];
			await expect(executeSidebar()).rejects.toMatchObject({ code: "permission-denied" });
		}
		expect(sidebarCalls).toEqual([]);
		plugins = [plugin({ id: "sidebar-folders" })];
		expect(await executeSidebar()).toBe(SIDEBAR_RESULT);
		expect(sidebarCalls).toEqual([{ connectionId: SIDEBAR_CONNECTION.id, command: { operation: "list-folders" } }]);
		expect(statusReads).toBe(8);
	});

	test("only the finite command and optional rendererConnectionId params are accepted", async () => {
		const invalid: Record<string, unknown>[] = [
			{},
			{ command: undefined },
			{ command: null },
			{ command: [] },
			{ command: "list-folders" },
			{ command: {} },
			{ operation: "list-folders" },
			{ command: { operation: "evaluate", code: "globalThis" } },
			{ command: { operation: "list-folders", rendererConnectionId: OTHER_CONNECTION.id } },
			{ command: { operation: "create-folder", name: "" } },
			{ command: { operation: "delete-folder", folder: null } },
			{ command: { operation: "move-bot", bot: "bot-1" } },
			{ command: { operation: "move-bot", bot: "bot-1", folder: null, rendererConnectionId: OTHER_CONNECTION.id } },
			{ command: { operation: "list-folders" }, connectionId: OTHER_CONNECTION.id },
			{ command: { operation: "list-folders" }, rendererId: OTHER_CONNECTION.id },
			{ command: { operation: "list-folders" }, rendererConnectionId: SIDEBAR_CONNECTION.id, raw: true },
		];
		for (const params of invalid) {
			await expect(executeSidebar(params)).rejects.toMatchObject({ code: "bad-request" });
		}
		expect(sidebarCalls).toEqual([]);
		expect(statusReads).toBe(0);
	});

	test("a supplied rendererConnectionId must be a positive safe integer for both direct and CLI callers", async () => {
		for (const connection of [SIDEBAR_CONNECTION, CLI_CONNECTION]) {
			for (const rendererConnectionId of [undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", true, [], {}]) {
				await expect(executeSidebar({ command: { operation: "list-folders" }, rendererConnectionId }, connection)).rejects.toMatchObject({ code: "bad-request" });
			}
		}
		expect(sidebarCalls).toEqual([]);
		expect(statusReads).toBe(0);
	});

	test("each finite command is parsed and delegated intact, including null folder unassignment", async () => {
		const cases: { command: SidebarCommand; result: SidebarResult }[] = [
			{ command: { operation: "list-folders" }, result: SIDEBAR_RESULT },
			{ command: { operation: "list-bots" }, result: { operation: "list-bots", bots: [{ id: "bot-1", name: "First", folderId: "folder-1" }] } },
			{ command: { operation: "create-folder", name: "Work" }, result: { operation: "create-folder", folder: { id: "folder-1", name: "Work", botIds: [] } } },
			{ command: { operation: "delete-folder", folder: "folder-1" }, result: { operation: "delete-folder", deletedFolder: { id: "folder-1", name: "Work", botIds: ["bot-1"] }, unassignedBotIds: ["bot-1"] } },
			{ command: { operation: "move-bot", bot: "bot-1", folder: null }, result: { operation: "move-bot", bot: { id: "bot-1", name: "First", folderId: null } } },
		];
		for (const { command, result } of cases) {
			sidebarResult = result;
			expect(await executeSidebar({ command })).toBe(result);
		}
		expect(sidebarCalls).toEqual(cases.map(({ command }) => ({ connectionId: SIDEBAR_CONNECTION.id, command })));
	});

	test("renderer SidebarError rejection is preserved for the bridge frame mapper", async () => {
		const error = new SidebarError("conflict", "Multiple folders match Work", { candidates: ["folder-1", "folder-2"] });
		const sidebar = recordingSidebar();
		handlers = create(recordingMcp(), {
			renderers: sidebar.renderers,
			async requestSidebar(connectionId, command) {
				await sidebar.requestSidebar(connectionId, command);
				throw error;
			},
		});
		await expect(executeSidebar()).rejects.toBe(error);
		expect(sidebarCalls).toEqual([{ connectionId: SIDEBAR_CONNECTION.id, command: { operation: "list-folders" } }]);
	});
});

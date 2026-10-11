import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, JSONRPCMessageSchema, ListToolsRequestSchema, type CallToolRequest, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdir } from "node:fs/promises";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { BGB_RENDERER_META_KEY, BGB_SIDEBAR_MCP_ID, type McpServerConfig, type McpToolResult } from "../../sdk/index.ts";
import { fakePlatform, tempContext, waitFor } from "../agent/testing.ts";
import type { CoreContext } from "../context.ts";
import { sidebarMcpConfig } from "../mcp-sidebar-config.ts";
import { type McpServersOptions, McpServers } from "./mcp.ts";

interface WireTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

interface WireRequest {
	id?: number | string;
	method: string;
	params?: Record<string, unknown>;
}

interface PeerOptions {
	pages?: WireTool[][];
	result?: McpToolResult;
	failList?: boolean;
	failCall?: boolean;
	hang?: "initialize" | "tools/list" | "tools/call";
	listGate?: Promise<void>;
}

interface RecordedRequest {
	method: string;
	url: string;
	headers: Headers;
	message?: WireRequest;
}

interface WirePeer {
	url: string;
	requests: RecordedRequest[];
	messages(): WireRequest[];
	calls(): RecordedRequest[];
	openedStreams(): number;
	closedStreams(): number;
	stop(): Promise<void>;
}

interface SdkPeer {
	transport: InMemoryTransport;
	calls: CallToolRequest["params"][];
	listRequests(): number;
}

let ctx: CoreContext & { cleanup(): Promise<void> };
const services: McpServers[] = [];
const peers: WirePeer[] = [];
const sdkServers: Server[] = [];

beforeEach(async () => {
	ctx = await tempContext(fakePlatform("linux"));
});

afterEach(async () => {
	for (const service of services.splice(0)) await service.shutdown();
	for (const server of sdkServers.splice(0)) await server.close();
	for (const server of peers.splice(0)) await server.stop();
	await ctx.cleanup();
});

function create(options: McpServersOptions = {}): McpServers {
	const service = new McpServers(ctx, options);
	services.push(service);
	return service;
}

const ECHO: WireTool = {
	name: "echo",
	description: "Returns the configured peer's response",
	inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
};

/** A real HTTP MCP wire peer: no Client/transport internals are mocked. */
function peer(options: PeerOptions = {}): WirePeer {
	const requests: RecordedRequest[] = [];
	let openedStreams = 0;
	let closedStreams = 0;
	const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	function stream(): Response {
		let controller: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
				streams.add(value);
				openedStreams++;
				value.enqueue(new TextEncoder().encode(": connected\n\n"));
			},
			cancel() {
				streams.delete(controller);
				closedStreams++;
			},
		});
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	}
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const record: RecordedRequest = { method: request.method, url: request.url, headers: new Headers(request.headers) };
			requests.push(record);
			if (request.method === "GET") return stream();
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const parsed = JSONRPCMessageSchema.parse(await request.json());
			if (!("method" in parsed)) return new Response(null, { status: 400 });
			const message: WireRequest = parsed;
			record.message = message;
			if (message.id === undefined) return new Response(null, { status: 202 });
			if (options.hang === message.method) return stream();
			const result = (value: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result: value });
			const failure = () => Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32042, message: "peer refused", data: { reason: "test" } } });
			switch (message.method) {
				case "initialize":
					return result({
						protocolVersion: "2025-03-26",
						capabilities: { tools: {} },
						serverInfo: { name: "loopback-test", version: "1.0.0" },
					});
				case "tools/list": {
					await options.listGate;
					if (options.failList) return failure();
					const pages = options.pages ?? [[ECHO]];
					const index = message.params?.cursor === undefined ? 0 : Number(message.params.cursor);
					return result({ tools: pages[index] ?? [], ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}) });
				}
				case "tools/call":
					if (options.failCall) return failure();
					return result(options.result ?? { content: [{ type: "text", text: "hello" }] });
				default:
					return failure();
			}
		},
	});
	const value = {
		url: `http://127.0.0.1:${server.port}/mcp`,
		requests,
		messages: () => requests.flatMap((request) => request.message ? [request.message] : []),
		calls: () => requests.filter((request) => request.message?.method === "tools/call"),
		openedStreams: () => openedStreams,
		closedStreams: () => closedStreams,
		async stop() {
			for (const controller of streams) controller.close();
			streams.clear();
			await server.stop(true);
		},
	};
	peers.push(value);
	return value;
}

function config(server: WirePeer, id = "test", enabled = true): McpServerConfig {
	return { id, name: id, enabled, transport: "http", url: server.url, headers: { Authorization: "Bearer wire-secret", "X-Mcp-Test": id } };
}

/** The real SDK parses request envelopes on both ends of this linked transport. */
async function sdkPeer(
	call: (params: CallToolRequest["params"]) => CallToolResult | Promise<CallToolResult> = () => ({ content: [{ type: "text", text: "hello" }] }),
): Promise<SdkPeer> {
	const calls: CallToolRequest["params"][] = [];
	let listRequests = 0;
	const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = new Server({ name: "in-memory-test", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, () => {
		listRequests++;
		return { tools: [ECHO] };
	});
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		calls.push(request.params);
		return await call(request.params);
	});
	sdkServers.push(server);
	await server.connect(serverTransport);
	return { transport, calls, listRequests: () => listRequests };
}

async function managedConfig(): Promise<Extract<McpServerConfig, { transport: "stdio" }>> {
	await mkdir(ctx.paths.bin, { recursive: true });
	await Bun.write(`${ctx.paths.bin}/${ctx.platform.binName()}`, "#!/bin/sh\nexit 1\n");
	const server = sidebarMcpConfig(ctx);
	if (server.transport !== "stdio") throw new Error("The managed sidebar preset must use stdio");
	return { ...server, enabled: true };
}

test("save and list are lazy; persisted reload retains configuration without network requests", async () => {
	const wire = peer();
	const service = create();
	const server = config(wire);
	expect(await service.list()).toEqual([]);
	await service.save(server);
	expect(await service.list()).toEqual([{ config: server, state: "disconnected", toolCount: 0 }]);
	const persisted: unknown = await Bun.file(`${ctx.paths.root}/mcp.json`).json();
	expect(persisted).toEqual({ version: 1, servers: [server] });
	await service.shutdown();
	expect(await create().list()).toEqual([{ config: server, state: "disconnected", toolCount: 0 }]);
	expect(wire.requests).toEqual([]);
});

test("connect paginates discovery without calling tools, forwards configured headers, and preserves tool results", async () => {
	const second: WireTool = { name: "second", inputSchema: { type: "object", required: ["value"] } };
	const response: McpToolResult = {
		content: [{ type: "text", text: "tool-level failure" }, { type: "resource_link", uri: "https://example.test/output", name: "output" }],
		structuredContent: { accepted: false, nested: { count: 2 } },
		isError: true,
	};
	const wire = peer({ pages: [[ECHO], [second]], result: response });
	const other = peer();
	const service = create();
	const server = config(wire);
	await service.save(server);
	expect(await service.connect(server.id)).toEqual({ config: server, state: "connected", toolCount: 2 });
	expect(wire.calls()).toEqual([]);
	expect(wire.messages().filter((message) => message.method === "tools/list").map((message) => message.params?.cursor)).toEqual([undefined, "1"]);
	expect(await service.tools()).toEqual([{ serverId: server.id, ...ECHO }, { serverId: server.id, ...second }]);
	const args = { text: "hello", url: other.url, serverId: "other" };
	expect(await service.call(server.id, ECHO.name, args)).toEqual(response);
	expect(wire.calls().map((request) => request.message?.params)).toEqual([{ name: ECHO.name, arguments: args }]);
	expect(other.requests).toEqual([]);
	for (const request of wire.requests) {
		expect(request.url).toBe(server.transport === "http" ? server.url : "unreachable");
		expect(request.headers.get("authorization")).toBe("Bearer wire-secret");
		expect(request.headers.get("x-mcp-test")).toBe(server.id);
	}
});

test("managed SDK calls isolate concurrent renderer metadata from raw arguments and never cache it on the session", async () => {
	const firstGate = Promise.withResolvers<void>();
	const secondGate = Promise.withResolvers<void>();
	const wire = await sdkPeer(async (params) => {
		if (params.arguments?.text === "first") await firstGate.promise;
		if (params.arguments?.text === "second") await secondGate.promise;
		return {
			content: [{ type: "text", text: String(params.arguments?.text) }],
			structuredContent: { rendererConnectionId: params._meta?.[BGB_RENDERER_META_KEY] ?? null },
		};
	});
	const server = await managedConfig();
	const transports: Extract<McpServerConfig, { transport: "stdio" }>[] = [];
	const service = create({ createStdioTransport: (config) => {
		transports.push(config);
		return wire.transport;
	} });
	await service.save(server);
	expect(await service.connect(server.id)).toEqual({ config: server, state: "connected", toolCount: 1 });
	const firstArgs = { text: "first", rendererConnectionId: 22, _meta: { [BGB_RENDERER_META_KEY]: 999, progressToken: "untrusted-first" } };
	const secondArgs = { text: "second", rendererConnectionId: 11, _meta: { [BGB_RENDERER_META_KEY]: 888, progressToken: "untrusted-second" } };
	const completions: number[] = [];
	const first = service.call(server.id, ECHO.name, firstArgs, { rendererConnectionId: 11 }).then((result) => {
		completions.push(11);
		return result;
	});
	const second = service.call(server.id, ECHO.name, secondArgs, { rendererConnectionId: 22 }).then((result) => {
		completions.push(22);
		return result;
	});
	const settled = Promise.allSettled([first, second]);
	try {
		await waitFor(() => wire.calls.length === 2, 2_000, "concurrent SDK tool calls");
		expect(wire.calls.find((params) => params.arguments?.text === "first")).toEqual({
			name: ECHO.name, arguments: firstArgs, _meta: { [BGB_RENDERER_META_KEY]: 11 },
		});
		expect(wire.calls.find((params) => params.arguments?.text === "second")).toEqual({
			name: ECHO.name, arguments: secondArgs, _meta: { [BGB_RENDERER_META_KEY]: 22 },
		});
		expect(completions).toEqual([]);
		secondGate.resolve();
		expect(await second).toEqual({
			content: [{ type: "text", text: "second" }], structuredContent: { rendererConnectionId: 22 },
		});
		expect(completions).toEqual([22]);
		firstGate.resolve();
		expect(await first).toEqual({
			content: [{ type: "text", text: "first" }], structuredContent: { rendererConnectionId: 11 },
		});
		expect(completions).toEqual([22, 11]);
		const args = { text: "no-context", rendererConnectionId: 11, _meta: { [BGB_RENDERER_META_KEY]: 22 } };
		expect(await service.call(server.id, ECHO.name, args)).toEqual({
			content: [{ type: "text", text: "no-context" }], structuredContent: { rendererConnectionId: null },
		});
		expect(wire.calls[2]).toEqual({ name: ECHO.name, arguments: args });
		expect(wire.calls[2]).not.toHaveProperty("_meta");
		expect(transports).toEqual([server]);
		expect(wire.listRequests()).toBe(1);
	} finally {
		firstGate.resolve();
		secondGate.resolve();
		await settled;
	}
});

test("an HTTP collision with the canonical sidebar ID never receives metadata from an earlier managed session", async () => {
	const managed = await managedConfig();
	const local = await sdkPeer();
	const wire = peer();
	const service = create({ createStdioTransport: () => local.transport });
	await service.save(managed);
	await service.connect(managed.id);
	await service.call(managed.id, ECHO.name, {}, { rendererConnectionId: 11 });
	const remote = config(wire, BGB_SIDEBAR_MCP_ID);
	await service.save(remote);
	expect(await service.connect(remote.id)).toEqual({ config: remote, state: "connected", toolCount: 1 });
	const args = { text: "remote", rendererConnectionId: 999, _meta: { [BGB_RENDERER_META_KEY]: 888 } };
	for (const context of [{ rendererConnectionId: 22 }, { rendererConnectionId: 0 }, undefined]) {
		expect(await service.call(remote.id, ECHO.name, args, context)).toEqual({ content: [{ type: "text", text: "hello" }] });
	}
	expect(wire.calls().map((request) => request.message?.params)).toEqual([
		{ name: ECHO.name, arguments: args },
		{ name: ECHO.name, arguments: args },
		{ name: ECHO.name, arguments: args },
	]);
	for (const request of wire.calls()) expect(request.message?.params).not.toHaveProperty("_meta");
	expect(local.calls).toEqual([{ name: ECHO.name, arguments: {}, _meta: { [BGB_RENDERER_META_KEY]: 11 } }]);
});

const nonManagedStdioConfigs: {
	name: string;
	change(config: Extract<McpServerConfig, { transport: "stdio" }>): Extract<McpServerConfig, { transport: "stdio" }>;
}[] = [
	{ name: "an unrelated ID", change: (config) => ({ ...config, id: "unrelated-stdio" }) },
	{ name: "an altered command", change: (config) => ({ ...config, command: `${config.command}-other` }) },
	{ name: "an altered argument", change: (config) => ({ ...config, args: [...config.args.slice(0, -1), "other-command"] }) },
	{ name: "an extra argument", change: (config) => ({ ...config, args: [...config.args, "--extra"] }) },
	{ name: "an altered environment", change: (config) => ({ ...config, env: { BGB_METADATA_TEST: "override" } }) },
	{ name: "an altered working directory", change: (config) => ({ ...config, cwd: ctx.paths.root }) },
];

for (const { name, change } of nonManagedStdioConfigs) {
	test(`stdio with ${name} receives unchanged arguments without managed metadata or context validation`, async () => {
		const managed = await managedConfig();
		const local = await sdkPeer();
		const wire = await sdkPeer();
		const transports = [local.transport, wire.transport];
		const service = create({ createStdioTransport: () => {
			const transport = transports.shift();
			if (!transport) throw new Error("Unexpected extra stdio session");
			return transport;
		} });
		await service.save(managed);
		await service.connect(managed.id);
		await service.call(managed.id, ECHO.name, {}, { rendererConnectionId: 11 });
		const server = change(managed);
		await service.save(server);
		expect(await service.connect(server.id)).toEqual({ config: server, state: "connected", toolCount: 1 });
		const args = { text: "external", rendererConnectionId: 999, _meta: { [BGB_RENDERER_META_KEY]: 888 } };
		for (const context of [{ rendererConnectionId: 22 }, { rendererConnectionId: 0 }, undefined]) {
			expect(await service.call(server.id, ECHO.name, args, context)).toEqual({ content: [{ type: "text", text: "hello" }] });
		}
		expect(wire.calls).toEqual([
			{ name: ECHO.name, arguments: args },
			{ name: ECHO.name, arguments: args },
			{ name: ECHO.name, arguments: args },
		]);
		for (const params of wire.calls) expect(params).not.toHaveProperty("_meta");
		expect(local.calls).toEqual([{ name: ECHO.name, arguments: {}, _meta: { [BGB_RENDERER_META_KEY]: 11 } }]);
		expect(transports).toEqual([]);
		expect(wire.listRequests()).toBe(1);
	});
}

test("invalid managed renderer contexts reject before tools/call and positive safe integer boundaries remain valid", async () => {
	const server = await managedConfig();
	const wire = await sdkPeer();
	const service = create({ createStdioTransport: () => wire.transport });
	await service.save(server);
	expect(await service.connect(server.id)).toEqual({ config: server, state: "connected", toolCount: 1 });
	for (const rendererConnectionId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
		await expect(service.call(server.id, ECHO.name, {}, { rendererConnectionId })).rejects.toMatchObject({ code: "bad-request" });
		expect(wire.calls).toEqual([]);
	}
	for (const rendererConnectionId of [1, Number.MAX_SAFE_INTEGER]) {
		expect(await service.call(server.id, ECHO.name, {}, { rendererConnectionId })).toEqual({ content: [{ type: "text", text: "hello" }] });
	}
	expect(wire.calls).toEqual([
		{ name: ECHO.name, arguments: {}, _meta: { [BGB_RENDERER_META_KEY]: 1 } },
		{ name: ECHO.name, arguments: {}, _meta: { [BGB_RENDERER_META_KEY]: Number.MAX_SAFE_INTEGER } },
	]);
});

test("explicit connection of a disabled server does not enable it or permit tool consumption", async () => {
	const wire = peer();
	const service = create();
	const server = config(wire, "disabled", false);
	await service.save(server);
	expect(await service.connect(server.id)).toEqual({ config: server, state: "connected", toolCount: 1 });
	await waitFor(() => wire.openedStreams() === 1, 2_000, "disabled server event stream");
	const requestCount = wire.requests.length;
	expect(await service.tools()).toEqual([]);
	await expect(service.call(server.id, "echo", {})).rejects.toMatchObject({ code: "permission-denied" });
	expect((await service.list())[0]?.config.enabled).toBe(false);
	expect(wire.requests).toHaveLength(requestCount);
	expect(await Bun.file(`${ctx.paths.root}/mcp.json`).json()).toEqual({ version: 1, servers: [server] });
});

test("tools queries servers concurrently and retains healthy schemas when another discovery fails", async () => {
	const gate = Promise.withResolvers<void>();
	const healthy = peer({ listGate: gate.promise });
	const unhealthy = peer({ failList: true });
	const service = create();
	await service.save(config(healthy, "healthy"));
	await service.save(config(unhealthy, "unhealthy"));
	const result = service.tools();
	try {
		await waitFor(() => [healthy, unhealthy].every((wire) => wire.messages().some((message) => message.method === "tools/list")), 2_000, "concurrent discovery");
	} finally {
		gate.resolve();
	}
	expect(await result).toEqual([{ serverId: "healthy", ...ECHO }]);
	const statuses = await service.list();
	expect(statuses.find((status) => status.config.id === "healthy")).toMatchObject({ state: "connected", toolCount: 1 });
	expect(statuses.find((status) => status.config.id === "unhealthy")).toMatchObject({ state: "error", toolCount: 0, detail: expect.any(String) });
	expect(healthy.calls()).toEqual([]);
	expect(unhealthy.calls()).toEqual([]);
});

test("same-name tools dispatch by serverId and unknown or undiscovered calls never send requests", async () => {
	const first = peer({ result: { content: [{ type: "text", text: "first" }] } });
	const second = peer({ result: { content: [{ type: "text", text: "second" }] } });
	const service = create();
	await service.save(config(first, "first"));
	await service.save(config(second, "second"));
	await expect(service.call("first", "echo", {})).rejects.toMatchObject({ code: "unavailable" });
	expect(first.requests).toEqual([]);
	expect(await service.tools()).toEqual([{ serverId: "first", ...ECHO }, { serverId: "second", ...ECHO }]);
	await expect(service.call("first", "unknown", {})).rejects.toMatchObject({ code: "not-found" });
	await expect(service.call("missing", "echo", {})).rejects.toMatchObject({ code: "not-found" });
	expect(first.calls()).toEqual([]);
	expect(second.calls()).toEqual([]);
	expect(await service.call("second", "echo", { value: 2 })).toEqual({ content: [{ type: "text", text: "second" }] });
	expect(await service.call("first", "echo", { value: 1 })).toEqual({ content: [{ type: "text", text: "first" }] });
	expect(first.calls().map((request) => request.message?.params)).toEqual([{ name: "echo", arguments: { value: 1 } }]);
	expect(second.calls().map((request) => request.message?.params)).toEqual([{ name: "echo", arguments: { value: 2 } }]);
});

for (const action of ["edit", "disable", "remove", "shutdown"] as const) {
	test(`${action} closes a stale HTTP client and discards its discovered tools`, async () => {
		const wire = peer();
		const replacement = peer({ result: { content: [{ type: "text", text: "replacement" }] } });
		const service = create();
		const server = config(wire);
		await service.save(server);
		await service.connect(server.id);
		await waitFor(() => wire.openedStreams() === 1, 2_000, "HTTP event stream");
		switch (action) {
			case "edit":
				await service.save({ ...config(replacement), name: "edited" });
				break;
			case "disable":
				await service.save({ ...server, enabled: false });
				break;
			case "remove":
				await service.remove(server.id);
				break;
			case "shutdown":
				await service.shutdown();
				break;
		}
		await waitFor(() => wire.closedStreams() === 1, 2_000, "stale client close");
		const code = action === "disable" ? "permission-denied" : action === "remove" ? "not-found" : "unavailable";
		await expect(service.call(server.id, "echo", {})).rejects.toMatchObject({ code });
		expect(wire.calls()).toEqual([]);
		if (action === "edit") {
			expect(await service.list()).toEqual([{ config: { ...config(replacement), name: "edited" }, state: "disconnected", toolCount: 0 }]);
			await service.connect(server.id);
			expect(await service.call(server.id, "echo", {})).toEqual({ content: [{ type: "text", text: "replacement" }] });
		} else if (action === "disable") {
			expect(await service.tools()).toEqual([]);
		} else if (action === "remove") {
			expect(await create().list()).toEqual([]);
		} else {
			await expect(service.connect(server.id)).rejects.toMatchObject({ code: "unavailable" });
		}
	});
}

for (const method of ["initialize", "tools/list"] as const) {
	test(`connection deadline bounds ${method} and records an error status`, async () => {
		const wire = peer({ hang: method });
		const service = create({ connectionTimeoutMs: 100, closeTimeoutMs: 100 });
		await service.save(config(wire));
		const status = await service.connect("test");
		expect(status).toMatchObject({ state: "error", toolCount: 0, detail: expect.any(String) });
		expect((await service.list())[0]).toEqual(status);
		expect(wire.messages().some((message) => message.method === method)).toBe(true);
		expect(wire.calls()).toEqual([]);
	});
}

test("call deadline rejects a hung tool rather than returning a fabricated result", async () => {
	const wire = peer({ hang: "tools/call" });
	const service = create({ callTimeoutMs: 100, closeTimeoutMs: 100 });
	await service.save(config(wire));
	await service.connect("test");
	await expect(service.call("test", "echo", {})).rejects.toMatchObject({ code: "unavailable" });
	expect(wire.calls()).toHaveLength(1);
});

test("MCP protocol errors reject with the original code and data rather than a tool-level error result", async () => {
	const wire = peer({ failCall: true });
	const service = create();
	await service.save(config(wire));
	await service.connect("test");
	await expect(service.call("test", "echo", {})).rejects.toMatchObject({ code: "unavailable", data: { mcpCode: -32042, mcpData: { reason: "test" } } });
	expect(wire.calls()).toHaveLength(1);
});

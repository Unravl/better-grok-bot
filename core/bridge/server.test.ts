import { afterEach, expect, type Mock, spyOn, test } from "bun:test";
import type { Serve, Server, ServerWebSocket } from "bun";
import { BRIDGE_PROTOCOL, CLOSE_BAD_TOKEN, CLOSE_HELLO_TIMEOUT, CLOSE_PROTOCOL_MISMATCH, type HelperToAgent, SidebarError, type SidebarCommand, type SidebarResult } from "../../sdk/index.ts";
import { FakeClock } from "../../loader/test/fakes.ts";
import { waitFor } from "../agent/testing.ts";
import { BgbError } from "../errors.ts";
import { BGB_VERSION } from "../version.ts";
import { openWebSocket } from "./client.ts";
import { type Bridge, type BridgeOptions, startBridge } from "./server.ts";

const TOKEN = "test-token";
let bridge: Bridge | undefined;

afterEach(async () => {
	await bridge?.stop();
	bridge = undefined;
});

function start(opts: Partial<BridgeOptions> = {}): Bridge {
	bridge = startBridge({ port: 0, token: TOKEN, handlers: { "status.get": (_params, connection) => ({ echo: connection.id }) }, ...opts });
	return bridge;
}

interface Client {
	ws: WebSocket;
	frames: Record<string, unknown>[];
	closed: Promise<{ code: number; reason: string }>;
}

function connect(port: number, path: string, headers: Record<string, string>): Client {
	const ws = openWebSocket(`ws://127.0.0.1:${port}${path}`, headers);
	const frames: Record<string, unknown>[] = [];
	const closed = Promise.withResolvers<{ code: number; reason: string }>();
	ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
	ws.onclose = (event) => closed.resolve({ code: event.code, reason: event.reason });
	return { ws, frames, closed: closed.promise };
}

async function opened(client: Client): Promise<void> {
	if (client.ws.readyState === WebSocket.OPEN) return;
	const ready = Promise.withResolvers<void>();
	client.ws.onopen = () => ready.resolve();
	client.ws.onerror = () => ready.reject(new Error("socket error"));
	await ready.promise;
}

function hello(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "hello",
		protocol: BRIDGE_PROTOCOL,
		token: TOKEN,
		buildKey: "build-1",
		appVersion: "0.68.1",
		bgbVersion: BGB_VERSION,
		...overrides,
	});
}

async function renderer(port: number, overrides: Record<string, unknown> = {}): Promise<Client> {
	const client = connect(port, "/bgb", { Origin: "file://" });
	await opened(client);
	client.ws.send(hello(overrides));
	await waitFor(() => client.frames.some((frame) => frame.type === "welcome"), 2_000, "welcome");
	return client;
}

async function call(client: Client, id: number, method: string, params: unknown = {}): Promise<Record<string, unknown>> {
	client.ws.send(JSON.stringify({ type: "req", id, method, params }));
	await waitFor(() => client.frames.some((frame) => frame.type === "res" && frame.id === id), 2_000, `response ${id}`);
	const response = client.frames.find((frame) => frame.type === "res" && frame.id === id);
	if (!response) throw new Error("unreachable");
	return response;
}

function startWithSocketCapture(opts: Partial<BridgeOptions>, capture: (socket: ServerWebSocket<unknown>) => void): Bridge {
	const nativeServe = Bun.serve;
	const serveSpy = spyOn(Bun, "serve").mockImplementation(<T, R extends string = never>(options: Serve.Options<T, R>): Server<T> => {
		if (!options.websocket) throw new Error("Expected bridge websocket handlers");
		const websocket = options.websocket;
		return nativeServe<T, R>({
			...options,
			websocket: {
				...websocket,
				open(socket) {
					capture(socket);
					return websocket.open?.(socket);
				},
			},
		});
	});
	try {
		return start(opts);
	} finally {
		serveSpy.mockRestore();
	}
}

type SidebarOutcome = { ok: true; result: SidebarResult } | { ok: false; error: unknown };

interface SidebarAttempt {
	settled: boolean;
	completion: Promise<SidebarOutcome>;
}

function observeSidebar(promise: Promise<SidebarResult>): SidebarAttempt {
	const attempt: SidebarAttempt = {
		settled: false,
		completion: promise.then(
			(result): SidebarOutcome => {
				attempt.settled = true;
				return { ok: true, result };
			},
			(error: unknown): SidebarOutcome => {
				attempt.settled = true;
				return { ok: false, error };
			},
		),
	};
	return attempt;
}

async function sidebarRequest(client: Client, index = 0): Promise<Record<string, unknown>> {
	await waitFor(() => client.frames.filter((frame) => frame.type === "sidebar.req").length > index, 2_000, `sidebar request ${index}`);
	const request = client.frames.filter((frame) => frame.type === "sidebar.req")[index];
	if (!request) throw new Error("Missing sidebar request");
	return request;
}

function expectUnknownSidebarFailure(outcome: SidebarOutcome, code: "unavailable" | "internal"): void {
	expect(outcome.ok).toBe(false);
	if (outcome.ok) throw new Error("Expected sidebar failure");
	expect(outcome.error).toBeInstanceOf(BgbError);
	expect(outcome.error).toHaveProperty("code", code);
}

test("GET /health identifies the agent", async () => {
	const { port } = start();
	const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
	expect(body).toEqual({ name: "better-grok-bot", version: BGB_VERSION, pid: process.pid });
});

test("a hello with a bad token is closed with 4001", async () => {
	const { port } = start();
	const client = connect(port, "/bgb", { Origin: "file://" });
	await opened(client);
	client.ws.send(hello({ token: "wrong" }));
	expect((await client.closed).code).toBe(CLOSE_BAD_TOKEN);
});

test("a hello of another protocol is closed with 4002", async () => {
	const { port } = start();
	const client = connect(port, "/bgb", { Origin: "file://" });
	await opened(client);
	client.ws.send(hello({ protocol: 2 }));
	expect((await client.closed).code).toBe(CLOSE_PROTOCOL_MISMATCH);
});

test("no hello within the timeout is closed with 4003", async () => {
	const { port } = start({ helloTimeoutMs: 100 });
	const client = connect(port, "/bgb", { Origin: "null" });
	await opened(client);
	expect((await client.closed).code).toBe(CLOSE_HELLO_TIMEOUT);
});

test("the /bgb upgrade requires Origin file:// or null", async () => {
	const { port } = start();
	expect((await fetch(`http://127.0.0.1:${port}/bgb`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
	expect((await fetch(`http://127.0.0.1:${port}/bgb`)).status).toBe(403);
	const evil = connect(port, "/bgb", { Origin: "https://evil.example" });
	expect((await evil.closed).code).not.toBe(1000);
	expect(bridge?.renderers()).toEqual([]);
});

test("POST /shutdown needs the bearer token", async () => {
	let requested = 0;
	const { port } = start({ onShutdownRequest: () => requested++ });
	const url = `http://127.0.0.1:${port}/shutdown`;
	expect((await fetch(url, { method: "POST" })).status).toBe(401);
	expect((await fetch(url, { method: "POST", headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
	expect(requested).toBe(0);
	expect((await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(202);
	await waitFor(() => requested === 1, 1_000, "shutdown callback");
});

test("the /helper upgrade needs the bearer token; helper frames are validated", async () => {
	const messages: HelperToAgent[] = [];
	const opens: number[] = [];
	const closes: number[] = [];
	const { port } = start({
		onHelperOpen: (connection) => opens.push(connection.id),
		onHelperMessage: (_connection, message) => messages.push(message),
		onHelperClose: (connection) => closes.push(connection.id),
	});
	expect((await fetch(`http://127.0.0.1:${port}/helper`)).status).toBe(401);
	const helper = connect(port, "/helper", { Authorization: `Bearer ${TOKEN}` });
	await opened(helper);
	await waitFor(() => opens.length === 1, 1_000, "helper open");
	helper.ws.send(JSON.stringify({ type: "key", code: "AltRight" }));
	helper.ws.send("not json");
	helper.ws.send(JSON.stringify({ type: "hello", protocol: 3, platform: "darwin", keys: "granted", codes: [], media: true }));
	helper.ws.send(JSON.stringify({ type: "key", code: "AltRight", down: true }));
	await waitFor(() => messages.length === 1, 1_000, "helper message");
	expect(messages).toEqual([{ type: "key", code: "AltRight", down: true }]);
	bridge?.sendHelper(opens[0] ?? 0, { type: "watch", codes: ["AltRight"] });
	await waitFor(() => helper.frames.length === 1, 1_000, "frame to helper");
	expect(helper.frames[0]).toEqual({ type: "watch", codes: ["AltRight"] });
	helper.ws.close();
	await waitFor(() => closes.length === 1, 1_000, "helper close");
});

test("welcome carries the current build key; requests map handler results and errors", async () => {
	const opened: string[] = [];
	const closed: string[] = [];
	const { port } = start({
		currentBuildKey: () => "current-key",
		onRendererOpen: (connection) => opened.push(connection.buildKey),
		onRendererClose: (connection) => closed.push(connection.buildKey),
		handlers: {
			"status.get": async (_params, connection) => ({ echo: connection.buildKey }),
			"build.rebuild": () => {
				throw new BgbError("conflict", "busy", { retry: true });
			},
			"themes.styles": () => {
				throw new Error("disk on fire");
			},
		},
	});
	const client = await renderer(port);
	expect(client.frames[0]).toEqual({ type: "welcome", protocol: 1, bgbVersion: BGB_VERSION, currentBuildKey: "current-key" });
	expect(opened).toEqual(["build-1"]);
	expect(bridge?.renderers().map((r) => r.buildKey)).toEqual(["build-1"]);

	expect(await call(client, 1, "status.get")).toEqual({ type: "res", id: 1, ok: true, result: { echo: "build-1" } });
	expect(await call(client, 2, "build.rebuild")).toEqual({
		type: "res",
		id: 2,
		ok: false,
		error: { code: "conflict", message: "busy", data: { retry: true } },
	});
	expect(await call(client, 3, "themes.styles")).toMatchObject({ ok: false, error: { code: "internal", message: "disk on fire" } });
	expect(await call(client, 4, "nope.nothing")).toMatchObject({ ok: false, error: { code: "bad-request" } });
	expect(await call(client, 5, "update.check")).toMatchObject({ ok: false, error: { code: "unavailable" } });
	expect(await call(client, 6, "status.get", [1, 2])).toMatchObject({ ok: false, error: { code: "bad-request" } });

	bridge?.broadcast("dev.reload", {});
	expect(bridge?.send(bridge.renderers()[0]?.id ?? 0, "keys.chord", { code: "F5" })).toBe(true);
	expect(bridge?.send(9_999, "keys.chord", { code: "F5" })).toBe(false);
	await waitFor(() => client.frames.filter((frame) => frame.type === "event").length === 2, 1_000, "events");
	expect(client.frames.filter((frame) => frame.type === "event")).toEqual([
		{ type: "event", name: "dev.reload", data: {} },
		{ type: "event", name: "keys.chord", data: { code: "F5" } },
	]);
	client.ws.close();
	await waitFor(() => closed.length === 1, 1_000, "renderer close");
});

test("stop closes every connection with the given code", async () => {
	const { port } = start();
	const client = await renderer(port);
	await bridge?.stop({ code: 1012, reason: "moving" });
	expect(await client.closed).toEqual({ code: 1012, reason: "moving" });
	await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
});

test("binding a busy port throws", async () => {
	const { port } = start();
	expect(() => startBridge({ port, token: TOKEN, handlers: {} })).toThrow();
});

test("a sidebar mutation reaches only the explicitly addressed capable window, once", async () => {
	const clock = new FakeClock();
	const host = start({ sidebarClock: clock });
	const other = await renderer(host.port, { capabilities: ["sidebar-folders"] });
	const target = await renderer(host.port, { capabilities: ["sidebar-folders"] });
	const [otherConnection, targetConnection] = host.renderers();
	if (!otherConnection || !targetConnection) throw new Error("Missing test renderer");
	const command = { operation: "create-folder", name: "Research" } satisfies SidebarCommand;
	const attempt = observeSidebar(host.requestSidebar(targetConnection.id, command));
	const request = await sidebarRequest(target);
	await call(other, 1, "status.get");
	await call(target, 1, "status.get");

	expect(request).toEqual({ type: "sidebar.req", id: expect.any(Number), command });
	expect(Number.isSafeInteger(request.id)).toBe(true);
	expect(request.id).toBeGreaterThan(0);
	expect(target.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([request]);
	expect(other.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([]);
	expect(attempt.settled).toBe(false);
	expect(clock.pendingTimers).toBe(1);

	const result = { operation: "create-folder", folder: { id: "folder-research", name: "Research", botIds: [] } } satisfies SidebarResult;
	target.ws.send(JSON.stringify({ type: "sidebar.res", id: request.id, ok: true, result }));
	expect(await attempt.completion).toEqual({ ok: true, result });
	expect(clock.pendingTimers).toBe(0);
});

test("another window cannot settle a sidebar request by forging its id", async () => {
	const clock = new FakeClock();
	const host = start({ sidebarClock: clock });
	const target = await renderer(host.port, { capabilities: ["sidebar-folders"] });
	const attacker = await renderer(host.port, { capabilities: ["sidebar-folders"] });
	const connection = host.renderers()[0];
	if (!connection) throw new Error("Missing target renderer");
	const attempt = observeSidebar(host.requestSidebar(connection.id, { operation: "delete-folder", folder: "folder-1" }));
	const request = await sidebarRequest(target);
	attacker.ws.send(JSON.stringify({
		type: "sidebar.res",
		id: request.id,
		ok: true,
		result: { operation: "delete-folder", deletedFolder: { id: "forged", name: "Forged", botIds: [] }, unassignedBotIds: [] },
	}));
	attacker.ws.send(JSON.stringify({ type: "sidebar.res", id: request.id, ok: false, error: { code: "conflict", message: "forged error" } }));
	attacker.ws.send(JSON.stringify({ type: "sidebar.res", id: request.id, ok: true, result: { operation: "arbitrary-export" } }));
	await call(attacker, 1, "status.get");
	expect(attempt.settled).toBe(false);
	expect(clock.pendingTimers).toBe(1);
	expect(attacker.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([]);

	const result = {
		operation: "delete-folder",
		deletedFolder: { id: "folder-1", name: "Research", botIds: ["bot-1"] },
		unassignedBotIds: ["bot-1"],
	} satisfies SidebarResult;
	target.ws.send(JSON.stringify({ type: "sidebar.res", id: request.id, ok: true, result }));
	expect(await attempt.completion).toEqual({ ok: true, result });
	expect(clock.pendingTimers).toBe(0);
});

test("an authenticated helper cannot answer a renderer's sidebar request", async () => {
	const clock = new FakeClock();
	const messages: HelperToAgent[] = [];
	const host = start({
		sidebarClock: clock,
		onHelperMessage: (connection, message) => {
			messages.push(message);
			if (message.type === "log") bridge?.sendHelper(connection.id, { type: "watch", codes: [] });
		},
	});
	const target = await renderer(host.port, { capabilities: ["sidebar-folders"] });
	const helper = connect(host.port, "/helper", { Authorization: `Bearer ${TOKEN}` });
	await opened(helper);
	const connection = host.renderers()[0];
	if (!connection) throw new Error("Missing target renderer");
	const attempt = observeSidebar(host.requestSidebar(connection.id, { operation: "move-bot", bot: "bot-1", folder: null }));
	const request = await sidebarRequest(target);
	const result = { operation: "move-bot", bot: { id: "bot-1", name: "Bot", folderId: null } } satisfies SidebarResult;
	helper.ws.send(JSON.stringify({ type: "sidebar.res", id: request.id, ok: true, result }));
	helper.ws.send(JSON.stringify({ type: "log", level: "info", message: "sidebar forgery consumed" }));
	await waitFor(() => helper.frames.some((frame) => frame.type === "watch"), 2_000, "helper barrier response");
	expect(messages).toEqual([{ type: "log", level: "info", message: "sidebar forgery consumed" }]);
	expect(attempt.settled).toBe(false);
	expect(clock.pendingTimers).toBe(1);
	expect(helper.frames).toEqual([{ type: "watch", codes: [] }]);

	target.ws.send(JSON.stringify({ type: "sidebar.res", id: request.id, ok: true, result }));
	expect(await attempt.completion).toEqual({ ok: true, result });
	expect(clock.pendingTimers).toBe(0);
});

test("concurrent sidebar requests on two exact sockets complete in reverse order", async () => {
	const clock = new FakeClock();
	const host = start({ sidebarClock: clock });
	const first = await renderer(host.port, { capabilities: ["sidebar-folders"] });
	const second = await renderer(host.port, { capabilities: ["sidebar-folders"] });
	const [firstConnection, secondConnection] = host.renderers();
	if (!firstConnection || !secondConnection) throw new Error("Missing test renderer");
	const firstCommand = { operation: "create-folder", name: "First" } satisfies SidebarCommand;
	const secondCommand = { operation: "create-folder", name: "Second" } satisfies SidebarCommand;
	const firstAttempt = observeSidebar(host.requestSidebar(firstConnection.id, firstCommand));
	const secondAttempt = observeSidebar(host.requestSidebar(secondConnection.id, secondCommand));
	const firstRequest = await sidebarRequest(first);
	const secondRequest = await sidebarRequest(second);
	expect(firstRequest.command).toEqual(firstCommand);
	expect(secondRequest.command).toEqual(secondCommand);
	expect(firstRequest.id).not.toBe(secondRequest.id);
	expect(clock.pendingTimers).toBe(2);

	const secondResult = { operation: "create-folder", folder: { id: "folder-second", name: "Second", botIds: [] } } satisfies SidebarResult;
	second.ws.send(JSON.stringify({ type: "sidebar.res", id: secondRequest.id, ok: true, result: secondResult }));
	expect(await secondAttempt.completion).toEqual({ ok: true, result: secondResult });
	await call(first, 1, "status.get");
	expect(firstAttempt.settled).toBe(false);
	expect(clock.pendingTimers).toBe(1);

	const firstResult = { operation: "create-folder", folder: { id: "folder-first", name: "First", botIds: [] } } satisfies SidebarResult;
	first.ws.send(JSON.stringify({ type: "sidebar.res", id: firstRequest.id, ok: true, result: firstResult }));
	expect(await firstAttempt.completion).toEqual({ ok: true, result: firstResult });
	expect(clock.pendingTimers).toBe(0);
	expect(first.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([firstRequest]);
	expect(second.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([secondRequest]);
});

for (const [label, reply] of [
	["an unknown result operation", { ok: true, result: { operation: "arbitrary-export" } }],
	["a malformed matching result", { ok: true, result: { operation: "create-folder", folder: { id: "folder-1", name: "Research", botIds: [1] } } }],
	["extra matching result fields", { ok: true, result: { operation: "create-folder", folder: { id: "folder-1", name: "Research", botIds: [] }, arbitrary: true } }],
	["extra envelope fields", { ok: true, result: { operation: "create-folder", folder: { id: "folder-1", name: "Research", botIds: [] } }, arbitrary: true }],
	["a valid result for the wrong operation", { ok: true, result: { operation: "list-folders", folders: [] } }],
	["a nonboolean success flag", { ok: "true", result: { operation: "create-folder", folder: { id: "folder-1", name: "Research", botIds: [] } } }],
	["a missing result", { ok: true }],
	["an unknown wire error code", { ok: false, error: { code: "retry", message: "not a bridge error" } }],
	["a malformed wire error message", { ok: false, error: { code: "conflict", message: 1 } }],
	["extra wire error fields", { ok: false, error: { code: "conflict", message: "busy", arbitrary: true } }],
] as const) {
	test(`a target sidebar response with ${label} rejects internal with an unknown mutation outcome`, async () => {
		const clock = new FakeClock();
		const host = start({ sidebarClock: clock });
		const target = await renderer(host.port, { capabilities: ["sidebar-folders"] });
		const connection = host.renderers()[0];
		if (!connection) throw new Error("Missing target renderer");
		const attempt = observeSidebar(host.requestSidebar(connection.id, { operation: "create-folder", name: "Research" }));
		const request = await sidebarRequest(target);
		target.ws.send(JSON.stringify({ type: "sidebar.res", id: request.id, ...reply }));
		expectUnknownSidebarFailure(await attempt.completion, "internal");
		expect(clock.pendingTimers).toBe(0);
	});
}

for (const [code, data] of [
	["bad-request", undefined],
	["not-found", { folder: "missing" }],
	["conflict", { matches: ["folder-1", "folder-2"], retryable: false, retryAfterMs: 0 }],
	["permission-denied", { operation: "delete-folder", selection: null }],
	["unavailable", null],
	["internal", { detail: { bots: ["bot-1"], canRetry: false } }],
] as const) {
	test(`SidebarError ${code} preserves exact code and data in both wire directions`, async () => {
		const clock = new FakeClock();
		const message = `sidebar ${code}`;
		const command = { operation: "move-bot", bot: "bot-1", folder: null } satisfies SidebarCommand;
		const host = start({
			sidebarClock: clock,
			handlers: {
				"sidebar.execute": () => {
					throw new SidebarError(code, message, data);
				},
			},
		});
		const target = await renderer(host.port, { capabilities: ["sidebar-folders"] });
		const wireError = { code, message, ...(data === undefined ? {} : { data }) };
		expect(await call(target, 1, "sidebar.execute", { command })).toEqual({ type: "res", id: 1, ok: false, error: wireError });

		const connection = host.renderers()[0];
		if (!connection) throw new Error("Missing target renderer");
		const attempt = observeSidebar(host.requestSidebar(connection.id, command));
		const request = await sidebarRequest(target);
		target.ws.send(JSON.stringify({ type: "sidebar.res", id: request.id, ok: false, error: wireError }));
		const outcome = await attempt.completion;
		expect(outcome.ok).toBe(false);
		if (outcome.ok || !(outcome.error instanceof BgbError)) throw new Error("Expected a reverse bridge error");
		expect({ code: outcome.error.code, message: outcome.error.message, data: outcome.error.data }).toEqual({ code, message, data });
		expect(clock.pendingTimers).toBe(0);
	});
}

test("old renderers, empty capabilities, advertising CLI clients and missing ids reject without sending", async () => {
	const clock = new FakeClock();
	const connectionIds: number[] = [];
	const host = start({ sidebarClock: clock, onRendererOpen: (connection) => connectionIds.push(connection.id) });
	const old = await renderer(host.port);
	const incapable = await renderer(host.port, { capabilities: [] });
	const cli = await renderer(host.port, { buildKey: "cli", capabilities: ["sidebar-folders"] });
	const capable = await renderer(host.port, { capabilities: ["sidebar-folders"] });
	const [oldId, incapableId, cliId, capableId] = connectionIds;
	if (oldId === undefined || incapableId === undefined || cliId === undefined || capableId === undefined) throw new Error("Missing test connection");
	const command = { operation: "create-folder", name: "Must not be created" } satisfies SidebarCommand;
	for (const id of [oldId, incapableId, cliId, 99_999]) {
		const attempt = observeSidebar(host.requestSidebar(id, command));
		const outcome = await attempt.completion;
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("Expected unavailable target");
		expect(outcome.error).toBeInstanceOf(BgbError);
		expect(outcome.error).toMatchObject({ code: "unavailable" });
		expect(clock.pendingTimers).toBe(0);
	}
	for (const client of [old, incapable, cli, capable]) {
		await call(client, 1, "status.get");
		expect(client.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([]);
	}
});

for (const [label, capabilities] of [
	["a string", "sidebar-folders"],
	["null", null],
	["an object", { "sidebar-folders": true }],
	["a number", 1],
	["a nonstring array member", [1]],
	["an unknown capability", ["arbitrary-export"]],
	["a mixed capability list", ["sidebar-folders", "arbitrary-export"]],
] as const) {
	test(`hello capabilities containing ${label} close with protocol mismatch`, async () => {
		const openedConnections: number[] = [];
		const host = start({ onRendererOpen: (connection) => openedConnections.push(connection.id) });
		const client = connect(host.port, "/bgb", { Origin: "file://" });
		await opened(client);
		client.ws.send(hello({ capabilities }));
		expect((await client.closed).code).toBe(CLOSE_PROTOCOL_MISMATCH);
		expect(openedConnections).toEqual([]);
		expect(client.frames).toEqual([]);
		expect(host.renderers()).toEqual([]);
	});
}

test("disconnect cancels its timer immediately and reconnect cannot resolve or replay the old mutation", async () => {
	const clock = new FakeClock();
	const timersAtClose: number[] = [];
	const host = start({ sidebarClock: clock, onRendererClose: () => timersAtClose.push(clock.pendingTimers) });
	const old = await renderer(host.port, { capabilities: ["sidebar-folders"] });
	const oldConnection = host.renderers()[0];
	if (!oldConnection) throw new Error("Missing old renderer");
	const oldCommand = { operation: "create-folder", name: "Old mutation" } satisfies SidebarCommand;
	const oldAttempt = observeSidebar(host.requestSidebar(oldConnection.id, oldCommand));
	const oldRequest = await sidebarRequest(old);
	expect(clock.pendingTimers).toBe(1);
	old.ws.close();
	await waitFor(() => timersAtClose.length === 1, 2_000, "renderer close callback");
	expect(timersAtClose).toEqual([0]);
	expectUnknownSidebarFailure(await oldAttempt.completion, "unavailable");
	expect(clock.pendingTimers).toBe(0);
	await old.closed;

	const replacement = await renderer(host.port, { capabilities: ["sidebar-folders"] });
	const replacementConnection = host.renderers()[0];
	if (!replacementConnection) throw new Error("Missing replacement renderer");
	expect(replacementConnection.id).not.toBe(oldConnection.id);
	expect(replacementConnection.buildKey).toBe(oldConnection.buildKey);
	const staleResult = { operation: "create-folder", folder: { id: "old-folder", name: "Old mutation", botIds: [] } } satisfies SidebarResult;
	replacement.ws.send(JSON.stringify({ type: "sidebar.res", id: oldRequest.id, ok: true, result: staleResult }));
	await call(replacement, 1, "status.get");
	expect(replacement.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([]);
	expect(clock.pendingTimers).toBe(0);
	expectUnknownSidebarFailure(await oldAttempt.completion, "unavailable");

	const newCommand = { operation: "create-folder", name: "New explicit mutation" } satisfies SidebarCommand;
	const newAttempt = observeSidebar(host.requestSidebar(replacementConnection.id, newCommand));
	const newRequest = await sidebarRequest(replacement);
	expect(newRequest.id).not.toBe(oldRequest.id);
	expect(newRequest.command).toEqual(newCommand);
	replacement.ws.send(JSON.stringify({ type: "sidebar.res", id: oldRequest.id, ok: true, result: staleResult }));
	await call(replacement, 2, "status.get");
	expect(newAttempt.settled).toBe(false);
	expect(clock.pendingTimers).toBe(1);

	const newResult = { operation: "create-folder", folder: { id: "new-folder", name: "New explicit mutation", botIds: [] } } satisfies SidebarResult;
	replacement.ws.send(JSON.stringify({ type: "sidebar.res", id: newRequest.id, ok: true, result: newResult }));
	expect(await newAttempt.completion).toEqual({ ok: true, result: newResult });
	expect(clock.pendingTimers).toBe(0);
	expect(old.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([oldRequest]);
	expect(replacement.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([newRequest]);
});

test("the fake 20-second sidebar deadline expires without retry and late frames cannot affect newer ids", async () => {
	const clock = new FakeClock();
	const host = start({ sidebarClock: clock });
	const target = await renderer(host.port, { capabilities: ["sidebar-folders"] });
	const connection = host.renderers()[0];
	if (!connection) throw new Error("Missing target renderer");
	const expiredCommand = { operation: "create-folder", name: "Expired mutation" } satisfies SidebarCommand;
	const expiredAttempt = observeSidebar(host.requestSidebar(connection.id, expiredCommand));
	const expiredRequest = await sidebarRequest(target);
	clock.advance(19_999);
	await call(target, 1, "status.get");
	expect(expiredAttempt.settled).toBe(false);
	expect(clock.pendingTimers).toBe(1);
	clock.advance(1);
	expect(clock.pendingTimers).toBe(0);
	const expiredOutcome = await expiredAttempt.completion;
	expectUnknownSidebarFailure(expiredOutcome, "unavailable");
	if (expiredOutcome.ok) throw new Error("Expected timeout");
	expect(expiredOutcome.error).toHaveProperty("message", expect.stringContaining("20 s"));

	const lateResult = { operation: "create-folder", folder: { id: "late-folder", name: "Expired mutation", botIds: [] } } satisfies SidebarResult;
	target.ws.send(JSON.stringify({ type: "sidebar.res", id: expiredRequest.id, ok: true, result: lateResult }));
	await call(target, 2, "status.get");
	expect(clock.pendingTimers).toBe(0);
	expect(target.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([expiredRequest]);

	const newerCommand = { operation: "create-folder", name: "Newer mutation" } satisfies SidebarCommand;
	const newerAttempt = observeSidebar(host.requestSidebar(connection.id, newerCommand));
	const newerRequest = await sidebarRequest(target, 1);
	expect(newerRequest.id).not.toBe(expiredRequest.id);
	target.ws.send(JSON.stringify({ type: "sidebar.res", id: expiredRequest.id, ok: true, result: lateResult }));
	target.ws.send(JSON.stringify({ type: "sidebar.res", id: expiredRequest.id, ok: false, error: { code: "conflict", message: "late error" } }));
	await call(target, 3, "status.get");
	expect(newerAttempt.settled).toBe(false);
	expect(clock.pendingTimers).toBe(1);
	clock.advance(19_999);
	expect(newerAttempt.settled).toBe(false);
	expect(clock.pendingTimers).toBe(1);

	const newerResult = { operation: "create-folder", folder: { id: "newer-folder", name: "Newer mutation", botIds: [] } } satisfies SidebarResult;
	target.ws.send(JSON.stringify({ type: "sidebar.res", id: newerRequest.id, ok: true, result: newerResult }));
	expect(await newerAttempt.completion).toEqual({ ok: true, result: newerResult });
	expect(clock.pendingTimers).toBe(0);
	clock.advance(20_000);
	expect(clock.pendingTimers).toBe(0);
	expectUnknownSidebarFailure(await expiredAttempt.completion, "unavailable");
	expect(target.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([expiredRequest, newerRequest]);
});

test("a dropped sidebar send rejects immediately, clears its timer and never replays the mutation", async () => {
	const clock = new FakeClock();
	const sockets: ServerWebSocket<unknown>[] = [];
	const host = startWithSocketCapture({ sidebarClock: clock }, (socket) => sockets.push(socket));
	const target = await renderer(host.port, { capabilities: ["sidebar-folders"] });
	const socket = sockets[0];
	const connection = host.renderers()[0];
	if (!socket || !connection) throw new Error("Missing target socket");
	const nativeSend = socket.send;
	const droppedFrames: Record<string, unknown>[] = [];
	const sendSpy = spyOn(socket, "send").mockImplementation((data, compress) => {
		if (typeof data === "string") {
			const frame = JSON.parse(data) as Record<string, unknown>;
			if (frame.type === "sidebar.req") {
				droppedFrames.push(frame);
				return 0;
			}
		}
		return nativeSend.call(socket, data, compress);
	});
	try {
		const command = { operation: "create-folder", name: "Dropped mutation" } satisfies SidebarCommand;
		const attempt = observeSidebar(host.requestSidebar(connection.id, command));
		expect(clock.pendingTimers).toBe(0);
		expect(droppedFrames).toEqual([{ type: "sidebar.req", id: expect.any(Number), command }]);
		const outcome = await attempt.completion;
		expectUnknownSidebarFailure(outcome, "unavailable");
		if (outcome.ok) throw new Error("Expected dropped-send failure");
		expect(outcome.error).toHaveProperty("message", expect.stringContaining("could not be sent"));
		await call(target, 1, "status.get");
		expect(target.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([]);
		clock.advance(20_000);
		await call(target, 2, "status.get");
		expect(clock.pendingTimers).toBe(0);
		expect(droppedFrames).toHaveLength(1);
		expect(target.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([]);
	} finally {
		sendSpy.mockRestore();
	}
});

test("a queued sidebar send under backpressure stays correlated until the actual renderer replies", async () => {
	const clock = new FakeClock();
	const sockets: ServerWebSocket<unknown>[] = [];
	const host = startWithSocketCapture({ sidebarClock: clock }, (socket) => sockets.push(socket));
	const target = await renderer(host.port, { capabilities: ["sidebar-folders"] });
	const socket = sockets[0];
	const connection = host.renderers()[0];
	if (!socket || !connection) throw new Error("Missing target socket");
	const nativeSend = socket.send;
	const queuedFrames: Record<string, unknown>[] = [];
	const sendSpy = spyOn(socket, "send").mockImplementation((data, compress) => {
		if (typeof data === "string") {
			const frame = JSON.parse(data) as Record<string, unknown>;
			if (frame.type === "sidebar.req") {
				queuedFrames.push(frame);
				nativeSend.call(socket, data, compress);
				return -1;
			}
		}
		return nativeSend.call(socket, data, compress);
	});
	try {
		const command = { operation: "create-folder", name: "Queued mutation" } satisfies SidebarCommand;
		const attempt = observeSidebar(host.requestSidebar(connection.id, command));
		const request = await sidebarRequest(target);
		await call(target, 1, "status.get");
		expect(queuedFrames).toEqual([request]);
		expect(request.command).toEqual(command);
		expect(attempt.settled).toBe(false);
		expect(clock.pendingTimers).toBe(1);
		const result = { operation: "create-folder", folder: { id: "queued-folder", name: "Queued mutation", botIds: [] } } satisfies SidebarResult;
		target.ws.send(JSON.stringify({ type: "sidebar.res", id: request.id, ok: true, result }));
		expect(await attempt.completion).toEqual({ ok: true, result });
		expect(clock.pendingTimers).toBe(0);
		expect(target.frames.filter((frame) => frame.type === "sidebar.req")).toEqual([request]);
	} finally {
		sendSpy.mockRestore();
	}
});

test("stop cancels all sidebar requests synchronously while native socket closes are held", async () => {
	const clock = new FakeClock();
	const closedConnections: number[] = [];
	const closeSpies: Mock<ServerWebSocket<unknown>["close"]>[] = [];
	const deferredCloses: (() => void)[] = [];
	const host = startWithSocketCapture(
		{ sidebarClock: clock, onRendererClose: (connection) => closedConnections.push(connection.id) },
		(socket) => {
			const nativeClose = socket.close;
			closeSpies.push(spyOn(socket, "close").mockImplementation((code, reason) => {
				deferredCloses.push(() => nativeClose.call(socket, code, reason));
			}));
		},
	);
	let stopped: Promise<void> | undefined;
	try {
		const first = await renderer(host.port, { capabilities: ["sidebar-folders"] });
		const second = await renderer(host.port, { capabilities: ["sidebar-folders"] });
		const [firstConnection, secondConnection] = host.renderers();
		if (!firstConnection || !secondConnection) throw new Error("Missing test renderer");
		const firstAttempt = observeSidebar(host.requestSidebar(firstConnection.id, { operation: "create-folder", name: "First mutation" }));
		const secondAttempt = observeSidebar(host.requestSidebar(secondConnection.id, { operation: "delete-folder", folder: "folder-2" }));
		await sidebarRequest(first);
		await sidebarRequest(second);
		expect(clock.pendingTimers).toBe(2);
		let stopFinished = false;
		stopped = host.stop().then(() => {
			stopFinished = true;
		});
		expect(clock.pendingTimers).toBe(0);
		expect(deferredCloses).toHaveLength(2);
		expect(closedConnections).toEqual([]);
		expect(first.ws.readyState).toBe(WebSocket.OPEN);
		expect(second.ws.readyState).toBe(WebSocket.OPEN);

		expectUnknownSidebarFailure(await firstAttempt.completion, "unavailable");
		expectUnknownSidebarFailure(await secondAttempt.completion, "unavailable");
		expect(closedConnections).toEqual([]);
		expect(first.ws.readyState).toBe(WebSocket.OPEN);
		expect(second.ws.readyState).toBe(WebSocket.OPEN);
		expect(stopFinished).toBe(false);
	} finally {
		for (const closeSpy of closeSpies) closeSpy.mockRestore();
		for (const close of deferredCloses) close();
		await stopped;
	}
	expect(closedConnections).toHaveLength(2);
});

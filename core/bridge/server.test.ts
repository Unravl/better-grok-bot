import { afterEach, expect, test } from "bun:test";
import { BRIDGE_PROTOCOL, CLOSE_BAD_TOKEN, CLOSE_HELLO_TIMEOUT, CLOSE_PROTOCOL_MISMATCH, type HelperToAgent } from "../../sdk/index.ts";
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
	bridge = startBridge({ port: 0, token: TOKEN, handlers: {}, ...opts });
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

async function renderer(port: number): Promise<Client> {
	const client = connect(port, "/bgb", { Origin: "file://" });
	await opened(client);
	client.ws.send(hello());
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

/**
 * The agent's local server (Step 4.1): `ws /bgb` for renderers (token hello), `ws /helper` for the
 * native helper (bearer token at upgrade), `GET /health` and `POST /shutdown`. It never imports the
 * method handlers; the agent passes them in.
 */
import { timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import {
	ALLOWED_ORIGINS,
	type AgentToHelper,
	BRIDGE_METHODS,
	BRIDGE_PATH,
	BRIDGE_PROTOCOL,
	type BridgeEvent,
	type BridgeEvents,
	type BridgeMethod,
	CLOSE_BAD_TOKEN,
	CLOSE_HELLO_TIMEOUT,
	CLOSE_PROTOCOL_MISMATCH,
	type EventFrame,
	HEALTH_PATH,
	HELLO_TIMEOUT_MS,
	HELPER_PATH,
	HELPER_PROTOCOL,
	type HelperToAgent,
	SHUTDOWN_PATH,
	type ServerFrame,
} from "../../sdk/index.ts";
import { BgbError } from "../errors.ts";
import { type Logger, nullLogger } from "../log.ts";
import { BGB_VERSION } from "../version.ts";
import { type Frame, parseFrame, toBridgeError } from "./frame.ts";

export interface RendererConnection {
	readonly id: number;
	/** `"cli"` for `connectBridge` clients (never counted as renderers). */
	readonly buildKey: string;
	readonly appVersion: string;
	readonly bgbVersion: string;
	readonly connectedAt: string;
}

export interface HelperConnection {
	readonly id: number;
	readonly connectedAt: string;
}

/** Receives validated-shape `params` (an object) and the calling connection; throws `BgbError` for bridge error codes. */
export type MethodHandler = (params: Record<string, unknown>, connection: RendererConnection) => unknown;
export type MethodHandlers = Partial<Record<BridgeMethod, MethodHandler>>;

export interface BridgeOptions {
	port: number;
	token: string;
	handlers: MethodHandlers;
	hostname?: string;
	helloTimeoutMs?: number;
	log?: Logger;
	/** `welcome.currentBuildKey`. */
	currentBuildKey?(): string | null;
	onRendererOpen?(connection: RendererConnection): void;
	onRendererClose?(connection: RendererConnection): void;
	onHelperOpen?(connection: HelperConnection): void;
	onHelperMessage?(connection: HelperConnection, message: HelperToAgent): void;
	onHelperClose?(connection: HelperConnection): void;
	/** `POST /shutdown` with the bearer token (answered 202 first). */
	onShutdownRequest?(): void;
}

export interface Bridge {
	readonly port: number;
	broadcast<E extends BridgeEvent>(event: E, data: BridgeEvents[E]): void;
	/** False when the connection is gone. */
	send<E extends BridgeEvent>(connectionId: number, event: E, data: BridgeEvents[E]): boolean;
	sendHelper(connectionId: number, message: AgentToHelper): boolean;
	closeHelper(connectionId: number, code?: number, reason?: string): void;
	renderers(): RendererConnection[];
	helpers(): HelperConnection[];
	/** Closes every connection (`code`, default 1001) and stops listening. */
	stop(opts?: { code?: number; reason?: string }): Promise<void>;
}

type SocketData =
	| { role: "renderer"; id: number; renderer: RendererConnection | null; timer: Timer | null }
	| { role: "helper"; id: number; helper: HelperConnection };

/** Validates a helper → agent frame (protocol v4 shapes); `null` when malformed or of another protocol. */
export function parseHelperFrame(frame: Frame): HelperToAgent | null {
	const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((item) => typeof item === "string");
	switch (frame.type) {
		case "hello": {
			const { protocol, platform, keys, codes, media } = frame;
			if (protocol !== HELPER_PROTOCOL || typeof media !== "boolean" || !strings(codes)) return null;
			if (platform !== "darwin" && platform !== "win32" && platform !== "linux") return null;
			if (keys !== "unsupported" && keys !== "denied" && keys !== "granted") return null;
			return { type: "hello", protocol: HELPER_PROTOCOL, platform, keys, codes, media };
		}
		case "access":
			return frame.keys === "denied" || frame.keys === "granted" ? { type: "access", keys: frame.keys } : null;
		case "key":
			return typeof frame.code === "string" && typeof frame.down === "boolean"
				? { type: "key", code: frame.code, down: frame.down }
				: null;
		case "chord":
			return typeof frame.code === "string" ? { type: "chord", code: frame.code } : null;
		case "log": {
			const { level, message } = frame;
			if (level !== "info" && level !== "warn" && level !== "error") return null;
			return typeof message === "string" ? { type: "log", level, message } : null;
		}
		default:
			return null;
	}
}

function tokenMatches(actual: string | null | undefined, token: string): boolean {
	if (typeof actual !== "string") return false;
	const a = Buffer.from(actual);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(request: Request): string | null {
	const header = request.headers.get("authorization");
	return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

/** Starts listening; throws (e.g. `EADDRINUSE`) when the port cannot be bound. */
export function startBridge(opts: BridgeOptions): Bridge {
	const log = opts.log ?? nullLogger;
	const helloTimeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
	const sockets = new Map<number, ServerWebSocket<SocketData>>();
	let nextId = 1;
	let stopping = false;

	const sendFrame = (ws: ServerWebSocket<SocketData>, frame: ServerFrame | AgentToHelper): void => {
		ws.send(JSON.stringify(frame));
	};

	const handleRequest = async (
		ws: ServerWebSocket<SocketData>,
		connection: RendererConnection,
		frame: Frame,
	): Promise<void> => {
		const id = frame.id;
		if (typeof id !== "number" || !Number.isInteger(id)) {
			log.warn(`bridge: request without an integer id from connection ${connection.id}`);
			return;
		}
		const method = frame.method;
		let response: ServerFrame;
		try {
			if (typeof method !== "string" || !(BRIDGE_METHODS as readonly string[]).includes(method)) {
				throw new BgbError("bad-request", `unknown method ${String(method)}`);
			}
			const handler = opts.handlers[method as BridgeMethod];
			if (!handler) throw new BgbError("unavailable", `${method} is not available`);
			const params = frame.params ?? {};
			if (typeof params !== "object" || params === null || Array.isArray(params)) {
				throw new BgbError("bad-request", "params must be an object");
			}
			response = { type: "res", id, ok: true, result: (await handler(params as Record<string, unknown>, connection)) ?? {} };
		} catch (error) {
			const bridgeError = toBridgeError(error);
			if (bridgeError.code === "internal") log.error(`bridge: ${String(method)} failed: ${bridgeError.message}`);
			response = { type: "res", id, ok: false, error: bridgeError };
		}
		if (sockets.has(ws.data.id)) sendFrame(ws, response);
	};

	const handleRenderer = (
		ws: ServerWebSocket<SocketData>,
		data: Extract<SocketData, { role: "renderer" }>,
		frame: Frame | null,
	): void => {
		if (data.renderer) {
			if (frame?.type === "req") void handleRequest(ws, data.renderer, frame);
			else log.warn(`bridge: ignored a non-request frame from connection ${data.id}`);
			return;
		}
		if (frame?.type !== "hello") {
			ws.close(CLOSE_PROTOCOL_MISMATCH, "expected hello");
			return;
		}
		if (typeof frame.token !== "string" || !tokenMatches(frame.token, opts.token)) {
			ws.close(CLOSE_BAD_TOKEN, "bad token");
			return;
		}
		const { protocol, buildKey, appVersion, bgbVersion } = frame;
		if (
			protocol !== BRIDGE_PROTOCOL ||
			typeof buildKey !== "string" ||
			typeof appVersion !== "string" ||
			typeof bgbVersion !== "string"
		) {
			ws.close(CLOSE_PROTOCOL_MISMATCH, "protocol mismatch");
			return;
		}
		clearTimeout(data.timer ?? undefined);
		data.timer = null;
		const renderer: RendererConnection = Object.freeze({
			id: data.id,
			buildKey,
			appVersion,
			bgbVersion,
			connectedAt: new Date().toISOString(),
		});
		data.renderer = renderer;
		sendFrame(ws, {
			type: "welcome",
			protocol: BRIDGE_PROTOCOL,
			bgbVersion: BGB_VERSION,
			currentBuildKey: opts.currentBuildKey?.() ?? null,
		});
		opts.onRendererOpen?.(renderer);
	};

	const handleHelper = (connection: HelperConnection, frame: Frame | null): void => {
		const message = frame && parseHelperFrame(frame);
		if (!message) {
			log.warn(`bridge: ignored a malformed helper frame (${frame?.type ?? "not JSON"})`);
			return;
		}
		opts.onHelperMessage?.(connection, message);
	};

	const server: Server<SocketData> = Bun.serve({
		hostname: opts.hostname ?? "127.0.0.1",
		port: opts.port,
		fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === HEALTH_PATH && request.method === "GET") {
				return Response.json({ name: "better-grok-bot", version: BGB_VERSION, pid: process.pid });
			}
			if (url.pathname === SHUTDOWN_PATH) {
				if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
				if (!tokenMatches(bearer(request), opts.token)) return new Response("unauthorized", { status: 401 });
				// Start after the 202 is on the wire; stopping closes this connection.
				setTimeout(() => opts.onShutdownRequest?.(), 100);
				return new Response("shutting down", { status: 202 });
			}
			if (url.pathname === BRIDGE_PATH) {
				const origin = request.headers.get("origin");
				if (origin === null || !ALLOWED_ORIGINS.includes(origin)) return new Response("forbidden", { status: 403 });
				const data: SocketData = { role: "renderer", id: nextId++, renderer: null, timer: null };
				if (srv.upgrade(request, { data })) return undefined;
				return new Response("expected a WebSocket upgrade", { status: 400 });
			}
			if (url.pathname === HELPER_PATH) {
				if (!tokenMatches(bearer(request), opts.token)) return new Response("unauthorized", { status: 401 });
				const id = nextId++;
				const data: SocketData = { role: "helper", id, helper: Object.freeze({ id, connectedAt: new Date().toISOString() }) };
				if (srv.upgrade(request, { data })) return undefined;
				return new Response("expected a WebSocket upgrade", { status: 400 });
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			data: {} as SocketData,
			maxPayloadLength: 1024 * 1024,
			open(ws) {
				if (stopping) {
					ws.close(1001, "agent stopping");
					return;
				}
				sockets.set(ws.data.id, ws);
				const data = ws.data;
				if (data.role === "renderer") {
					data.timer = setTimeout(() => {
						data.timer = null;
						if (!data.renderer) ws.close(CLOSE_HELLO_TIMEOUT, "hello timeout");
					}, helloTimeoutMs);
				} else {
					opts.onHelperOpen?.(data.helper);
				}
			},
			message(ws, raw) {
				const frame = parseFrame(raw);
				const data = ws.data;
				if (data.role === "helper") handleHelper(data.helper, frame);
				else handleRenderer(ws, data, frame);
			},
			close(ws) {
				const data = ws.data;
				if (!sockets.delete(data.id)) return;
				if (data.role === "renderer") {
					clearTimeout(data.timer ?? undefined);
					if (data.renderer) opts.onRendererClose?.(data.renderer);
				} else {
					opts.onHelperClose?.(data.helper);
				}
			},
		},
	});

	const port = server.port;
	if (port === undefined) throw new Error("bridge: server has no port");

	const renderers = (): [ServerWebSocket<SocketData>, RendererConnection][] => {
		const list: [ServerWebSocket<SocketData>, RendererConnection][] = [];
		for (const ws of sockets.values()) if (ws.data.role === "renderer" && ws.data.renderer) list.push([ws, ws.data.renderer]);
		return list;
	};

	return {
		port,
		broadcast(event, data) {
			const text = JSON.stringify({ type: "event", name: event, data });
			for (const [ws] of renderers()) ws.send(text);
		},
		send(connectionId, event, data) {
			const ws = sockets.get(connectionId);
			if (!ws || ws.data.role !== "renderer" || !ws.data.renderer) return false;
			const frame: EventFrame<typeof event> = { type: "event", name: event, data };
			sendFrame(ws, frame);
			return true;
		},
		sendHelper(connectionId, message) {
			const ws = sockets.get(connectionId);
			if (!ws || ws.data.role !== "helper") return false;
			sendFrame(ws, message);
			return true;
		},
		closeHelper(connectionId, code = 1000, reason = "replaced") {
			const ws = sockets.get(connectionId);
			if (ws?.data.role === "helper") ws.close(code, reason);
		},
		renderers: () => renderers().map(([, renderer]) => renderer),
		helpers() {
			const list: HelperConnection[] = [];
			for (const ws of sockets.values()) if (ws.data.role === "helper") list.push(ws.data.helper);
			return list;
		},
		async stop({ code = 1001, reason = "agent stopping" } = {}) {
			if (stopping) return;
			stopping = true;
			const open = [...sockets.values()];
			for (const ws of open) ws.close(code, reason);
			// Let close frames (and frames queued before them) flush before the listener goes away.
			const deadline = Date.now() + 1_000;
			while (sockets.size > 0 && Date.now() < deadline) await Bun.sleep(10);
			await server.stop(true);
		},
	};
}

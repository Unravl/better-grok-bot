/**
 * Bun-side bridge client for the CLI and `scripts/e2e.ts`: connects to `/bgb` like a renderer
 * (`Origin: file://`, token hello) with the build key `"cli"`, which the agent never counts as a renderer.
 */
import {
	BRIDGE_PATH,
	BRIDGE_PROTOCOL,
	type BridgeEvent,
	type BridgeEvents,
	type BridgeMethod,
	type BridgeMethods,
	CLOSE_BAD_TOKEN,
	CLOSE_HELLO_TIMEOUT,
	CLOSE_PROTOCOL_MISMATCH,
	type HelloFrame,
	type WelcomeFrame,
	methodTimeoutMs,
} from "../../sdk/index.ts";
import { readConfig } from "../config.ts";
import { BgbError } from "../errors.ts";
import type { DataPaths } from "../paths.ts";
import { BGB_VERSION } from "../version.ts";
import { fromBridgeError, parseFrame } from "./frame.ts";

export interface BridgeClient {
	readonly welcome: WelcomeFrame;
	/** Rejects with `BgbError(code, message, data)` on `ok:false`, and with `unavailable` on timeout or close. */
	request<M extends BridgeMethod>(method: M, params: BridgeMethods[M]["params"]): Promise<BridgeMethods[M]["result"]>;
	on<E extends BridgeEvent>(event: E, listener: (data: BridgeEvents[E]) => void): () => void;
	/** Called once when the connection closes (also after {@link close}). */
	onClose(listener: (code: number, reason: string) => void): () => void;
	close(): void;
}

function closeMessage(code: number, reason: string): string {
	switch (code) {
		case CLOSE_BAD_TOKEN:
			return "the agent rejected the bridge token in config.json";
		case CLOSE_PROTOCOL_MISMATCH:
			return "the agent speaks another bridge protocol (restart it: bgb stop && bgb start)";
		case CLOSE_HELLO_TIMEOUT:
			return "the agent did not receive the hello in time";
		default:
			return `bridge connection closed (${code}${reason ? ` ${reason}` : ""})`;
	}
}

interface Pending {
	resolve(result: unknown): void;
	reject(error: Error): void;
	timer: Timer;
}

type BunWebSocketConstructor = new (url: string, options: Bun.WebSocketOptions) => WebSocket;

/** A WebSocket client sending extra upgrade headers (`Origin`, `Authorization`), which Bun supports. */
export function openWebSocket(url: string, headers: Record<string, string>): WebSocket {
	// tsconfig's DOM lib hides Bun's options-object constructor overload; the runtime has it.
	const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;
	return new BunWebSocket(url, { headers });
}

/** Connects to the agent of `paths` (port and token from `config.json`) and completes the hello. */
export async function connectBridge(
	paths: DataPaths,
	opts: { timeoutMs?: number; buildKey?: string } = {},
): Promise<BridgeClient> {
	const config = await readConfig(paths);
	const timeoutMs = opts.timeoutMs ?? 5_000;
	const ws = openWebSocket(`ws://127.0.0.1:${config.bridgePort}${BRIDGE_PATH}`, { Origin: "file://" });
	const pending = new Map<number, Pending>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const closeListeners = new Set<(code: number, reason: string) => void>();
	let nextId = 1;
	let closed: { code: number; reason: string } | null = null;

	const handshake = Promise.withResolvers<WelcomeFrame>();
	const helloTimer = setTimeout(() => {
		handshake.reject(new BgbError("unavailable", `no answer from the agent on port ${config.bridgePort} within ${timeoutMs} ms`));
		ws.close();
	}, timeoutMs);
	ws.onopen = () => {
		const hello: HelloFrame = {
			type: "hello",
			protocol: BRIDGE_PROTOCOL,
			token: config.bridgeToken,
			buildKey: opts.buildKey ?? "cli",
			appVersion: "0.0.0",
			bgbVersion: BGB_VERSION,
		};
		ws.send(JSON.stringify(hello));
	};
	ws.onmessage = (event) => {
		const frame = parseFrame(String(event.data));
		if (frame?.type !== "welcome") return;
		clearTimeout(helloTimer);
		handshake.resolve({
			type: "welcome",
			protocol: BRIDGE_PROTOCOL,
			bgbVersion: typeof frame.bgbVersion === "string" ? frame.bgbVersion : "",
			currentBuildKey: typeof frame.currentBuildKey === "string" ? frame.currentBuildKey : null,
		});
	};
	ws.onerror = () => {
		clearTimeout(helloTimer);
		handshake.reject(new BgbError("unavailable", `cannot reach the agent on port ${config.bridgePort} (is it running? bgb start)`));
	};
	ws.onclose = (event) => {
		clearTimeout(helloTimer);
		handshake.reject(new BgbError("unavailable", closeMessage(event.code, event.reason)));
	};
	const welcome = await handshake.promise;

	ws.onmessage = (event) => {
		const frame = parseFrame(String(event.data));
		if (frame?.type === "res" && typeof frame.id === "number") {
			const entry = pending.get(frame.id);
			if (!entry) return;
			pending.delete(frame.id);
			clearTimeout(entry.timer);
			if (frame.ok === true) {
				entry.resolve(frame.result);
				return;
			}
			entry.reject(fromBridgeError(frame.error));
		} else if (frame?.type === "event" && typeof frame.name === "string") {
			for (const listener of listeners.get(frame.name) ?? []) listener(frame.data);
		}
	};
	ws.onerror = null;
	ws.onclose = (event) => {
		closed = { code: event.code, reason: event.reason };
		for (const [id, entry] of pending) {
			clearTimeout(entry.timer);
			entry.reject(new BgbError("unavailable", closeMessage(event.code, event.reason)));
			pending.delete(id);
		}
		for (const listener of closeListeners) listener(event.code, event.reason);
	};

	return {
		welcome,
		request<M extends BridgeMethod>(method: M, params: BridgeMethods[M]["params"]): Promise<BridgeMethods[M]["result"]> {
			if (closed) return Promise.reject(new BgbError("unavailable", closeMessage(closed.code, closed.reason)));
			const id = nextId++;
			const { promise, resolve, reject } = Promise.withResolvers<BridgeMethods[M]["result"]>();
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new BgbError("unavailable", `${method} timed out after ${methodTimeoutMs(method) / 1000} s`));
			}, methodTimeoutMs(method));
			// The agent answers `method` with its result type (bridge contract).
			pending.set(id, { resolve: (result) => resolve(result as BridgeMethods[M]["result"]), reject, timer });
			ws.send(JSON.stringify({ type: "req", id, method, params }));
			return promise;
		},
		on(event, listener) {
			const set = listeners.get(event) ?? new Set();
			listeners.set(event, set);
			const wrapped = (data: unknown): void => listener(data as BridgeEvents[typeof event]);
			set.add(wrapped);
			return () => set.delete(wrapped);
		},
		onClose(listener) {
			closeListeners.add(listener);
			return () => closeListeners.delete(listener);
		},
		close() {
			ws.close(1000, "client closing");
		},
	};
}

import {
	BRIDGE_PATH,
	BRIDGE_PROTOCOL,
	CLOSE_BAD_TOKEN,
	CLOSE_PROTOCOL_MISMATCH,
	methodTimeoutMs,
	type BridgeErrorCode,
	type BridgeEvent,
	type BridgeEvents,
	type BridgeMethod,
	type BridgeMethods,
	type BridgeState,
	type HelloFrame,
	type PluginLogger,
	type RequestFrame,
	type WelcomeFrame,
} from "../sdk/index.ts";
import type { Clock } from "./clock.ts";
import { describeError } from "./logger.ts";
import { isRecord } from "./payload.ts";

/** Builtins the bridge uses, captured at boot so code that patches them later cannot see the token. */
export interface CapturedGlobals {
	WebSocket: typeof WebSocket;
	parse: typeof JSON.parse;
	stringify: typeof JSON.stringify;
	apply: typeof Reflect.apply;
}

export function captureGlobals(global: typeof globalThis): CapturedGlobals {
	return Object.freeze({ WebSocket: global.WebSocket, parse: JSON.parse, stringify: JSON.stringify, apply: Reflect.apply });
}

export class BridgeRequestError extends Error {
	constructor(
		readonly code: BridgeErrorCode,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "BridgeRequestError";
	}
}

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
/** An open socket that sends no `welcome` this long after `hello` is not our agent; retry. */
export const WELCOME_TIMEOUT_MS = 10_000;

const ERROR_CODES: Record<BridgeErrorCode, true> = {
	"bad-request": true,
	"not-found": true,
	conflict: true,
	"permission-denied": true,
	unavailable: true,
	internal: true,
};

function isErrorCode(value: unknown): value is BridgeErrorCode {
	return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}

export interface BridgeClientOptions {
	port: number;
	token: string;
	buildKey: string;
	appVersion: string;
	bgbVersion: string;
	globals: CapturedGlobals;
	clock: Clock;
	log: PluginLogger;
}

export interface BridgeClient {
	readonly state: BridgeState;
	/** Port the client currently connects to (changes on `bridge.moving`). */
	readonly port: number;
	start(): void;
	stop(): void;
	subscribe(listener: (state: BridgeState) => void): () => void;
	/** Runs after every `welcome`, after state listeners saw `connected`. */
	onWelcome(listener: (welcome: WelcomeFrame) => void): () => void;
	on<E extends BridgeEvent>(event: E, listener: (data: BridgeEvents[E]) => void): () => void;
	/** Rejects with {@link BridgeRequestError}: the agent's error, `unavailable` while not connected, on close, or after the method's deadline. */
	request<M extends BridgeMethod>(method: M, params: BridgeMethods[M]["params"]): Promise<BridgeMethods[M]["result"]>;
}

interface Pending {
	resolve(result: unknown): void;
	reject(error: BridgeRequestError): void;
	timer: unknown;
}

/**
 * The renderer's connection to the agent at `ws://127.0.0.1:<port>/bgb`: `hello`/`welcome`
 * handshake, request/response correlation with per-method deadlines, events, and reconnects with
 * exponential backoff (1 s → 30 s, forever). The token and socket never leave this closure.
 */
export function createBridgeClient(options: BridgeClientOptions): BridgeClient {
	const { token, buildKey, appVersion, bgbVersion, clock, log } = options;
	const { WebSocket: Socket, parse, stringify, apply } = options.globals;
	const socketSend = Socket.prototype.send;
	const socketClose = Socket.prototype.close;

	let port = options.port;
	let state: BridgeState = "disconnected";
	let running = false;
	let socket: WebSocket | null = null;
	let welcomed = false;
	let everWelcomed = false;
	let delay = RECONNECT_MIN_MS;
	let retryTimer: unknown = null;
	let welcomeTimer: unknown = null;
	let nextId = 1;
	const reportedCloseCodes = new Set<number>();
	const pending = new Map<number, Pending>();
	const stateListeners = new Set<(state: BridgeState) => void>();
	const welcomeListeners = new Set<(welcome: WelcomeFrame) => void>();
	const eventListeners = new Map<string, Set<(data: unknown) => void>>();

	const notify = <T>(listeners: Iterable<(value: T) => void>, value: T, what: string): void => {
		for (const listener of [...listeners]) {
			try {
				listener(value);
			} catch (error) {
				log.error(`${what} listener threw:`, error);
			}
		}
	};

	const setState = (next: BridgeState): void => {
		if (state === next) return;
		state = next;
		notify(stateListeners, next, "bridge state");
	};

	const failPending = (message: string): void => {
		const entries = [...pending.values()];
		pending.clear();
		for (const entry of entries) {
			clock.clearTimeout(entry.timer);
			entry.reject(new BridgeRequestError("unavailable", message));
		}
	};

	const clearWelcomeTimer = (): void => {
		if (welcomeTimer !== null) clock.clearTimeout(welcomeTimer);
		welcomeTimer = null;
	};

	const closeQuietly = (ws: WebSocket, code?: number): void => {
		try {
			apply(socketClose, ws, code === undefined ? [] : [code]);
		} catch {
			// Already closed or never opened.
		}
	};

	const scheduleRetry = (): void => {
		if (!running || retryTimer !== null) return;
		retryTimer = clock.setTimeout(connect, delay);
		delay = Math.min(delay * 2, RECONNECT_MAX_MS);
	};

	/** The current socket is gone: fail its requests, report, and retry after the backoff delay. */
	const dropped = (code: number | undefined): void => {
		const wasWelcomed = welcomed;
		socket = null;
		welcomed = false;
		clearWelcomeTimer();
		failPending("the connection to Better Grok Bot's background agent closed");
		if (code === CLOSE_BAD_TOKEN || code === CLOSE_PROTOCOL_MISMATCH) {
			if (!reportedCloseCodes.has(code)) {
				reportedCloseCodes.add(code);
				log.error(
					code === CLOSE_BAD_TOKEN
						? "the background agent rejected this window's token; reload Grok Bot"
						: "the background agent speaks another bridge protocol; reload Grok Bot",
				);
			}
		} else if (wasWelcomed) {
			log.warn("lost the connection to the background agent; reconnecting");
		}
		setState("disconnected");
		scheduleRetry();
	};

	const connect = (): void => {
		retryTimer = null;
		if (!running) return;
		setState("connecting");
		let ws: WebSocket;
		try {
			ws = new Socket(`ws://127.0.0.1:${port}${BRIDGE_PATH}`);
		} catch (error) {
			log.warn(`cannot open the bridge socket: ${describeError(error)}`);
			dropped(undefined);
			return;
		}
		socket = ws;
		welcomed = false;
		ws.onopen = () => {
			if (socket !== ws) return;
			const hello: HelloFrame = { type: "hello", protocol: BRIDGE_PROTOCOL, token, buildKey, appVersion, bgbVersion };
			try {
				apply(socketSend, ws, [stringify(hello)]);
			} catch (error) {
				log.warn(`cannot greet the background agent: ${describeError(error)}`);
			}
			clearWelcomeTimer();
			welcomeTimer = clock.setTimeout(() => {
				welcomeTimer = null;
				if (socket !== ws || welcomed) return;
				log.warn(`port ${port} answered without a Better Grok Bot welcome; retrying`);
				socket = null;
				closeQuietly(ws);
				dropped(undefined);
			}, WELCOME_TIMEOUT_MS);
		};
		ws.onmessage = (event: MessageEvent) => {
			if (socket === ws) receive(ws, event.data);
		};
		ws.onclose = (event: CloseEvent) => {
			if (socket === ws) dropped(event.code);
		};
		ws.onerror = () => {
			// A `close` event always follows.
		};
	};

	const welcome = (frame: Record<string, unknown>): void => {
		if (frame.protocol !== BRIDGE_PROTOCOL) {
			log.error(`the background agent speaks bridge protocol ${String(frame.protocol)}, not ${BRIDGE_PROTOCOL}`);
			return;
		}
		const welcomeFrame: WelcomeFrame = {
			type: "welcome",
			protocol: BRIDGE_PROTOCOL,
			bgbVersion: typeof frame.bgbVersion === "string" ? frame.bgbVersion : "unknown",
			currentBuildKey: typeof frame.currentBuildKey === "string" ? frame.currentBuildKey : null,
		};
		welcomed = true;
		clearWelcomeTimer();
		delay = RECONNECT_MIN_MS;
		if (!everWelcomed) log.info(`connected to the background agent ${welcomeFrame.bgbVersion} on port ${port}`);
		everWelcomed = true;
		setState("connected");
		notify(welcomeListeners, welcomeFrame, "welcome");
	};

	const respond = (frame: Record<string, unknown>): void => {
		if (typeof frame.id !== "number") return;
		const entry = pending.get(frame.id);
		if (entry === undefined) return;
		pending.delete(frame.id);
		clock.clearTimeout(entry.timer);
		if (frame.ok === true) {
			entry.resolve(frame.result);
			return;
		}
		const error = isRecord(frame.error) ? frame.error : {};
		const code = isErrorCode(error.code) ? error.code : "internal";
		entry.reject(new BridgeRequestError(code, typeof error.message === "string" ? error.message : "request failed", error.data));
	};

	/** `bridge.moving`: the agent restarts on `port`; follow it right away with the same token. */
	const move = (data: unknown): void => {
		const next = isRecord(data) ? data.port : undefined;
		if (typeof next !== "number" || !Number.isInteger(next) || next <= 0 || next >= 65_536 || next === port) return;
		log.info(`the background agent is moving to port ${next}`);
		port = next;
		const ws = socket;
		socket = null;
		welcomed = false;
		clearWelcomeTimer();
		failPending("the background agent is moving to another port");
		if (ws !== null) closeQuietly(ws, 1000);
		if (retryTimer !== null) clock.clearTimeout(retryTimer);
		retryTimer = null;
		delay = RECONNECT_MIN_MS;
		setState("disconnected");
		connect();
	};

	const receive = (ws: WebSocket, data: unknown): void => {
		if (typeof data !== "string") return;
		let frame: unknown;
		try {
			frame = parse(data);
		} catch {
			log.warn("ignoring a malformed bridge frame");
			return;
		}
		if (!isRecord(frame)) return;
		if (!welcomed) {
			if (frame.type === "welcome") welcome(frame);
			return;
		}
		if (frame.type === "res") {
			respond(frame);
		} else if (frame.type === "event" && typeof frame.name === "string") {
			const listeners = eventListeners.get(frame.name);
			if (listeners !== undefined) notify(listeners, frame.data, `${frame.name} event`);
			if (frame.name === "bridge.moving" && socket === ws) move(frame.data);
		}
	};

	const client: BridgeClient = {
		get state() {
			return state;
		},
		get port() {
			return port;
		},
		start(): void {
			if (running) return;
			running = true;
			connect();
		},
		stop(): void {
			running = false;
			if (retryTimer !== null) clock.clearTimeout(retryTimer);
			retryTimer = null;
			const ws = socket;
			socket = null;
			welcomed = false;
			clearWelcomeTimer();
			if (ws !== null) closeQuietly(ws, 1000);
			failPending("the bridge client stopped");
			setState("disconnected");
		},
		subscribe(listener) {
			stateListeners.add(listener);
			return () => {
				stateListeners.delete(listener);
			};
		},
		onWelcome(listener) {
			welcomeListeners.add(listener);
			return () => {
				welcomeListeners.delete(listener);
			};
		},
		on<E extends BridgeEvent>(event: E, listener: (data: BridgeEvents[E]) => void): () => void {
			// Frames come from the agent this window authenticated with; their shapes follow the contract.
			const wrapped = (data: unknown): void => listener(data as BridgeEvents[E]);
			let listeners = eventListeners.get(event);
			if (listeners === undefined) {
				listeners = new Set();
				eventListeners.set(event, listeners);
			}
			listeners.add(wrapped);
			return () => {
				listeners.delete(wrapped);
			};
		},
		request<M extends BridgeMethod>(method: M, params: BridgeMethods[M]["params"]): Promise<BridgeMethods[M]["result"]> {
			const ws = socket;
			if (state !== "connected" || ws === null) {
				return Promise.reject(new BridgeRequestError("unavailable", "Better Grok Bot's background agent is not connected"));
			}
			const id = nextId++;
			const frame: RequestFrame<M> = { type: "req", id, method, params };
			const { promise, resolve, reject } = Promise.withResolvers<BridgeMethods[M]["result"]>();
			const timeoutMs = methodTimeoutMs(method);
			const timer = clock.setTimeout(() => {
				pending.delete(id);
				reject(new BridgeRequestError("unavailable", `${method} timed out after ${timeoutMs / 1000} s`));
			}, timeoutMs);
			pending.set(id, { resolve: (result) => resolve(result as BridgeMethods[M]["result"]), reject, timer });
			try {
				apply(socketSend, ws, [stringify(frame)]);
			} catch (error) {
				clock.clearTimeout(timer);
				pending.delete(id);
				reject(new BridgeRequestError("unavailable", describeError(error)));
			}
			return promise;
		},
	};
	return Object.freeze(client);
}

/** Stand-in when the boot payload carries no bridge: never connects, every request is `unavailable`. */
export function offlineBridgeClient(): BridgeClient {
	const noop = (): (() => void) => () => {};
	return Object.freeze({
		state: "disconnected",
		port: 0,
		start() {},
		stop() {},
		subscribe: noop,
		onWelcome: noop,
		on: noop,
		request: () => Promise.reject(new BridgeRequestError("unavailable", "this build has no Better Grok Bot agent connection")),
	});
}

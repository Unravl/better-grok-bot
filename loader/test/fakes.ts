/** Test doubles for loader tests (never bundled: only `*.test.ts` files import this). */
import type { BuildManifest, PluginLogger, PluginStatus, ReactLike } from "../../sdk/index.ts";
import type { CapturedGlobals } from "../bridge-client.ts";
import type { Clock } from "../clock.ts";
import { isRecord } from "../payload.ts";

interface FakeTimer {
	at: number;
	seq: number;
	callback: () => void;
}

/** A clock whose time only moves through `advance`, running due timers in order. */
export class FakeClock implements Clock {
	private time = 0;
	private seq = 0;
	private readonly timers = new Map<number, FakeTimer>();

	now(): number {
		return this.time;
	}

	setTimeout(callback: () => void, ms: number): unknown {
		const seq = ++this.seq;
		this.timers.set(seq, { at: this.time + Math.max(0, ms), seq, callback });
		return seq;
	}

	clearTimeout(handle: unknown): void {
		if (typeof handle === "number") this.timers.delete(handle);
	}

	advance(ms: number): void {
		const end = this.time + ms;
		for (;;) {
			let next: FakeTimer | undefined;
			for (const timer of this.timers.values()) {
				if (timer.at <= end && (next === undefined || timer.at < next.at || (timer.at === next.at && timer.seq < next.seq))) next = timer;
			}
			if (next === undefined) break;
			this.timers.delete(next.seq);
			this.time = next.at;
			next.callback();
		}
		this.time = end;
	}

	get pendingTimers(): number {
		return this.timers.size;
	}
}

export type Frame = Record<string, unknown>;

/** A WebSocket the test drives by hand: `accept`, `receive`, `drop`; `sent` holds parsed frames. */
export class FakeSocket {
	readyState = 0;
	readonly sent: Frame[] = [];
	closedWith: number | undefined;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;

	constructor(readonly url: string) {}

	send(data: string): void {
		const frame: unknown = JSON.parse(data);
		if (!isRecord(frame)) throw new Error("fake socket: non-object frame");
		this.sent.push(frame);
	}

	close(code?: number): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.closedWith = code ?? 1005;
		this.onclose?.({ code: this.closedWith });
	}

	accept(): void {
		this.readyState = 1;
		this.onopen?.({});
	}

	receive(frame: Frame): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}

	welcome(currentBuildKey: string | null = null): void {
		this.receive({ type: "welcome", protocol: 1, bgbVersion: "0.1.0", currentBuildKey });
	}

	event(name: string, data: unknown): void {
		this.receive({ type: "event", name, data });
	}

	drop(code = 1006): void {
		this.readyState = 3;
		this.onclose?.({ code });
	}

	requests(method?: string): Frame[] {
		return this.sent.filter((frame) => frame.type === "req" && (method === undefined || frame.method === method));
	}

	lastRequest(method: string): Frame {
		const request = this.requests(method).at(-1);
		if (request === undefined) throw new Error(`fake socket: no ${method} request`);
		return request;
	}

	reply(request: Frame, result: unknown): void {
		this.receive({ type: "res", id: request.id, ok: true, result });
	}

	fail(request: Frame, code: string, message: string): void {
		this.receive({ type: "res", id: request.id, ok: false, error: { code, message } });
	}
}

/** A fresh WebSocket class per test, with its own list of created sockets. */
export function createFakeSockets(): { WebSocket: typeof WebSocket; sockets: FakeSocket[]; last(): FakeSocket } {
	const sockets: FakeSocket[] = [];
	class Socket extends FakeSocket {
		constructor(url: string) {
			super(url);
			sockets.push(this);
		}
	}
	return {
		WebSocket: Socket as unknown as typeof WebSocket,
		sockets,
		last(): FakeSocket {
			const socket = sockets.at(-1);
			if (socket === undefined) throw new Error("fake socket: none created");
			return socket;
		},
	};
}

export function fakeGlobals(WebSocketClass: typeof WebSocket): CapturedGlobals {
	return { WebSocket: WebSocketClass, parse: JSON.parse, stringify: JSON.stringify, apply: Reflect.apply };
}

export interface RecordingLogger extends PluginLogger {
	readonly lines: string[];
}

export function recordingLogger(): RecordingLogger {
	const lines: string[] = [];
	const record =
		(level: string) =>
		(...args: unknown[]): void => {
			lines.push(`${level} ${args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" ")}`);
		};
	return { lines, info: record("info"), warn: record("warn"), error: record("error") };
}

export function pluginStatus(overrides: Partial<PluginStatus> & { id: string }): PluginStatus {
	return {
		name: overrides.id,
		description: "",
		version: "1.0.0",
		authors: [],
		source: "bundled",
		state: "active",
		errors: [],
		patches: [],
		permissions: [],
		granted: [],
		settings: {},
		hasRuntime: true,
		...overrides,
	};
}

export function manifestWith(plugins: PluginStatus[], overrides: Partial<BuildManifest> = {}): BuildManifest {
	return {
		bgbVersion: "0.1.0",
		buildFormat: 1,
		buildKey: "a".repeat(64),
		platform: "darwin",
		appVersion: "0.68.1",
		appFingerprint: "f".repeat(64),
		builtAt: "2026-10-11T00:00:00.000Z",
		plugins,
		themes: [],
		...overrides,
	};
}

export interface FakeElement {
	type: unknown;
	props: Record<string, unknown>;
	key: unknown;
}

function isFakeElement(value: unknown): value is FakeElement {
	return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

/**
 * Enough React for render-free tests: `createElement` returns plain objects; hooks read
 * their initial value (`useSyncExternalStore` reads the snapshot) and never re-render.
 */
export function createFakeReact(): ReactLike {
	class Component {
		state: unknown = null;
		constructor(readonly props: Record<string, unknown>) {}
		setState(state: unknown): void {
			this.state = state;
		}
	}
	return {
		Component,
		Fragment: Symbol("Fragment"),
		createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown {
			const { key, ...rest } = props ?? {};
			const element: FakeElement = { type, key, props: children.length === 0 ? rest : { ...rest, children: children.length === 1 ? children[0] : children } };
			return element;
		},
		useState: <S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void] => [
			typeof initial === "function" ? (initial as () => S)() : initial,
			() => {},
		],
		useEffect: () => {},
		useMemo: <T>(factory: () => T): T => factory(),
		useRef: <T>(initial: T): { current: T } => ({ current: initial }),
		useCallback: <T>(callback: T): T => callback,
		useSyncExternalStore: <T>(_subscribe: (onChange: () => void) => () => void, getSnapshot: () => T): T => getSnapshot(),
	};
}

/** Every element in a fake-React tree (depth first), following `props.children`. */
export function elements(tree: unknown): FakeElement[] {
	const found: FakeElement[] = [];
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
		} else if (isFakeElement(node)) {
			found.push(node);
			visit(node.props.children);
		}
	};
	visit(tree);
	return found;
}

/** Lets pending promise callbacks run (microtasks only, no wall clock) until `condition` holds. */
export async function settle(condition: () => boolean, rounds = 50): Promise<void> {
	for (let round = 0; round < rounds && !condition(); round++) await Promise.resolve();
	if (!condition()) throw new Error(`condition still false after ${rounds} microtask rounds`);
}

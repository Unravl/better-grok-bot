import {
	WATCHABLE_CODES,
	type AgentStatus,
	type KeysService,
	type KeysState,
	type McpServerConfig,
	type McpServerStatus,
	type McpService,
	type McpTool,
	type McpToolResult,
	type MediaService,
	type MediaState,
	type PluginLogger,
	type ServiceStateInfo,
} from "../sdk/index.ts";
import type { BridgeClient } from "./bridge-client.ts";
import { describeError } from "./logger.ts";

export type ServicesBridge = Pick<BridgeClient, "state" | "request" | "on" | "subscribe">;

export interface ServicesClient {
	keysFor(pluginId: string): KeysService;
	mediaFor(pluginId: string): MediaService;
	mcpFor(pluginId: string): McpService;
	/** Reconnect sequence steps 2–3: send this window's watch union (even when empty) and duck level. */
	resync(): void;
	/** Service states from a `status.get` result. */
	applyStatus(status: Pick<AgentStatus, "keys" | "media">): void;
}

const NOT_CONNECTED = "Better Grok Bot's background agent is not connected";

interface Watcher {
	pluginId: string;
	listener: (down: boolean) => void;
}

/**
 * The window's side of the `keys`, `media` and `mcp` services. Every plugin's watches share
 * one code → listeners map and one `keys.watch` union; every plugin keeps one duck level
 * and the window sends the minimum. Losing the agent releases every held key
 * (`listener(false)`). MCP requests retain plugin identity and propagate bridge failures.
 */
export function createServicesClient(bridge: ServicesBridge, log: PluginLogger): ServicesClient {
	const watchers = new Map<string, Set<Watcher>>();
	const downCodes = new Set<string>();
	const chordListeners = new Map<string, Set<(code: string) => void>>();
	const duckLevels = new Map<string, number>();
	const keysListeners = new Set<() => void>();
	const mediaListeners = new Set<() => void>();
	const keysServices = new Map<string, KeysService>();
	const mediaServices = new Map<string, MediaService>();
	const mcpServices = new Map<string, McpService>();
	const reportedUnsupported = new Set<string>();
	let keys: ServiceStateInfo<KeysState> = { state: "error", detail: NOT_CONNECTED };
	let media: ServiceStateInfo<MediaState> = { state: "error", detail: NOT_CONNECTED };
	let sentCodes = "";
	let sentLevel = 1;

	const safely = <A>(listener: (arg: A) => void, arg: A, what: string): void => {
		try {
			listener(arg);
		} catch (error) {
			log.error(`${what} listener threw:`, error);
		}
	};

	const watchUnion = (): string[] => [...watchers.keys()].sort();
	const duckLevel = (): number => Math.min(1, ...duckLevels.values());

	const sendWatch = (codes: string[]): void => {
		sentCodes = codes.join(",");
		if (bridge.state !== "connected") return;
		bridge.request("keys.watch", { codes }).then(
			({ unsupported }) => {
				const fresh = unsupported.filter((code) => !reportedUnsupported.has(code));
				for (const code of fresh) reportedUnsupported.add(code);
				if (fresh.length > 0) log.warn(`these keys can't be watched in the background on this OS: ${fresh.join(", ")}`);
			},
			(error: unknown) => log.warn(`could not update the background key watch: ${describeError(error)}`),
		);
	};

	const sendDuck = (level: number): void => {
		sentLevel = level;
		if (bridge.state !== "connected") return;
		bridge.request("media.duck", { level }).catch((error: unknown) => log.warn(`could not change the music level: ${describeError(error)}`));
	};

	const syncWatch = (): void => {
		const codes = watchUnion();
		if (codes.join(",") !== sentCodes) sendWatch(codes);
	};

	const syncDuck = (): void => {
		const level = duckLevel();
		if (level !== sentLevel) sendDuck(level);
	};

	const setKeys = (info: ServiceStateInfo<KeysState>): void => {
		if (info.state === keys.state && info.detail === keys.detail) return;
		keys = { state: info.state, detail: info.detail };
		for (const listener of [...keysListeners]) safely(listener, undefined, "keys state");
	};

	const setMedia = (info: ServiceStateInfo<MediaState>): void => {
		if (info.state === media.state && info.detail === media.detail) return;
		media = { state: info.state, detail: info.detail };
		for (const listener of [...mediaListeners]) safely(listener, undefined, "media state");
	};

	const releaseHeldKeys = (): void => {
		const held = [...downCodes];
		downCodes.clear();
		for (const code of held) {
			for (const watcher of [...(watchers.get(code) ?? [])]) safely(watcher.listener, false, `key ${code}`);
		}
	};

	bridge.on("keys.key", ({ code, down }) => {
		const codeWatchers = watchers.get(code);
		if (codeWatchers === undefined || down === downCodes.has(code)) return;
		if (down) downCodes.add(code);
		else downCodes.delete(code);
		for (const watcher of [...codeWatchers]) safely(watcher.listener, down, `key ${code}`);
	});

	bridge.on("keys.chord", ({ code }) => {
		const plugins = new Set([...(watchers.get(code) ?? [])].map((watcher) => watcher.pluginId));
		for (const pluginId of plugins) {
			for (const listener of [...(chordListeners.get(pluginId) ?? [])]) safely(listener, code, "chord");
		}
	});

	bridge.on("keys.state", setKeys);
	bridge.on("media.state", setMedia);

	bridge.subscribe((state) => {
		if (state === "connected") return;
		releaseHeldKeys();
		setKeys({ state: "error", detail: NOT_CONNECTED });
		setMedia({ state: "error", detail: NOT_CONNECTED });
	});

	const subscribeTo = (listeners: Set<() => void>, listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};

	const createKeys = (pluginId: string): KeysService =>
		Object.freeze({
			get state() {
				return keys.state;
			},
			get detail() {
				return keys.detail;
			},
			watch(code: string, listener: (down: boolean) => void): () => void {
				if (!WATCHABLE_CODES.has(code)) {
					throw new RangeError(`${code} can't be watched in the background: only modifier, function, lock and media keys can`);
				}
				if (typeof listener !== "function") throw new TypeError("keys.watch needs a listener function");
				const watcher: Watcher = { pluginId, listener };
				let codeWatchers = watchers.get(code);
				if (codeWatchers === undefined) {
					codeWatchers = new Set();
					watchers.set(code, codeWatchers);
				}
				codeWatchers.add(watcher);
				syncWatch();
				let watching = true;
				return () => {
					if (!watching) return;
					watching = false;
					codeWatchers.delete(watcher);
					if (codeWatchers.size === 0 && watchers.get(code) === codeWatchers) {
						watchers.delete(code);
						downCodes.delete(code);
					}
					syncWatch();
				};
			},
			onChord(listener: (code: string) => void): () => void {
				let listeners = chordListeners.get(pluginId);
				if (listeners === undefined) {
					listeners = new Set();
					chordListeners.set(pluginId, listeners);
				}
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			async install(): Promise<void> {
				await bridge.request("keys.install", {});
			},
			subscribe: (listener: () => void) => subscribeTo(keysListeners, listener),
		});

	const createMedia = (pluginId: string): MediaService =>
		Object.freeze({
			get state() {
				return media.state;
			},
			get detail() {
				return media.detail;
			},
			duck(level: number): void {
				if (typeof level !== "number" || Number.isNaN(level)) throw new RangeError("media.duck needs a level between 0 and 1");
				const clamped = Math.min(1, Math.max(0, level));
				if (clamped >= 1) duckLevels.delete(pluginId);
				else duckLevels.set(pluginId, clamped);
				syncDuck();
			},
			subscribe: (listener: () => void) => subscribeTo(mediaListeners, listener),
		});

	const createMcp = (pluginId: string): McpService =>
		Object.freeze({
			async list(): Promise<McpServerStatus[]> {
				const { servers } = await bridge.request("mcp.list", { pluginId });
				return servers;
			},
			async save(server: McpServerConfig): Promise<void> {
				await bridge.request("mcp.save", { pluginId, server });
			},
			async remove(id: string): Promise<void> {
				await bridge.request("mcp.remove", { pluginId, id });
			},
			connect(id: string): Promise<McpServerStatus> {
				return bridge.request("mcp.connect", { pluginId, id });
			},
			async tools(): Promise<McpTool[]> {
				const { tools } = await bridge.request("mcp.tools", { pluginId });
				return tools;
			},
			call(serverId: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
				return bridge.request("mcp.call", { pluginId, serverId, name, arguments: args });
			},
		});

	return Object.freeze({
		keysFor(pluginId: string): KeysService {
			let service = keysServices.get(pluginId);
			if (service === undefined) {
				service = createKeys(pluginId);
				keysServices.set(pluginId, service);
			}
			return service;
		},
		mediaFor(pluginId: string): MediaService {
			let service = mediaServices.get(pluginId);
			if (service === undefined) {
				service = createMedia(pluginId);
				mediaServices.set(pluginId, service);
			}
			return service;
		},
		mcpFor(pluginId: string): McpService {
			let service = mcpServices.get(pluginId);
			if (service === undefined) {
				service = createMcp(pluginId);
				mcpServices.set(pluginId, service);
			}
			return service;
		},
		resync(): void {
			sendWatch(watchUnion());
			sendDuck(duckLevel());
		},
		applyStatus(status: Pick<AgentStatus, "keys" | "media">): void {
			setKeys(status.keys);
			setMedia(status.media);
		},
	});
}

/** Renderer ↔ agent bridge protocol (JSON text frames over `ws://127.0.0.1:<port>/bgb`). */
import type { Permission, Platform } from "./constants.ts";
import type { PluginStatus, ThemeInfo } from "./manifest.ts";
import type { McpServerConfig, McpServerStatus, McpTool, McpToolResult } from "./mcp.ts";
import type { KeysState, MediaState } from "./runtime.ts";
import type { SidebarCommand, SidebarResult } from "./sidebar.ts";

export const BRIDGE_PATH = "/bgb";
export const HELPER_PATH = "/helper";
export const HEALTH_PATH = "/health";
export const SHUTDOWN_PATH = "/shutdown";
export const HELLO_TIMEOUT_MS = 5_000;

export const CLOSE_BAD_TOKEN = 4001;
export const CLOSE_PROTOCOL_MISMATCH = 4002;
export const CLOSE_HELLO_TIMEOUT = 4003;

/** `Origin` values accepted on the `/bgb` upgrade; anything else → HTTP 403. */
export const ALLOWED_ORIGINS: readonly string[] = ["file://", "null"];

export interface HelloFrame {
	type: "hello";
	protocol: 1;
	token: string;
	buildKey: string;
	/** From the user agent. */
	appVersion: string;
	bgbVersion: string;
	/** Loader capabilities; omitted by older clients and CLI connections. */
	capabilities?: ("sidebar-folders")[];
}

export interface WelcomeFrame {
	type: "welcome";
	protocol: 1;
	bgbVersion: string;
	currentBuildKey: string | null;
}

export type BridgeErrorCode = "bad-request" | "not-found" | "conflict" | "permission-denied" | "unavailable" | "internal";

export interface BridgeError {
	code: BridgeErrorCode;
	message: string;
	data?: unknown;
}

export interface RequestFrame<M extends BridgeMethod = BridgeMethod> {
	type: "req";
	id: number;
	method: M;
	params: BridgeMethods[M]["params"];
}

export type ResponseFrame =
	| { type: "res"; id: number; ok: true; result: unknown }
	| { type: "res"; id: number; ok: false; error: BridgeError };

/** The only host-initiated renderer operation; addressed to one authenticated socket. */
export interface SidebarRequestFrame {
	type: "sidebar.req";
	id: number;
	command: SidebarCommand;
}

export type SidebarResponseFrame =
	| { type: "sidebar.res"; id: number; ok: true; result: SidebarResult }
	| { type: "sidebar.res"; id: number; ok: false; error: BridgeError };

export interface EventFrame<E extends BridgeEvent = BridgeEvent> {
	type: "event";
	name: E;
	data: BridgeEvents[E];
}

export type ClientFrame = HelloFrame | RequestFrame | SidebarResponseFrame;
export type ServerFrame = WelcomeFrame | ResponseFrame | EventFrame | SidebarRequestFrame;

export interface ServiceStateInfo<S extends string> {
	state: S;
	detail?: string;
}

export type UpdateState = "idle" | "checking" | "available" | "downloading" | "installed" | "error" | "disabled";

export interface UpdateStatus {
	state: UpdateState;
	current: string;
	latest?: string;
	error?: string;
}

export interface AgentStatus {
	bgbVersion: string;
	platform: Platform;
	app: { version: string; path: string } | null;
	build: { key: string; appVersion: string; builtAt: string } | null;
	building: boolean;
	update: UpdateStatus;
	settings: { openAtLogin: boolean; autoUpdate: boolean };
	/** From the latest build manifest. */
	plugins: PluginStatus[];
	themes: ThemeInfo[];
	keys: ServiceStateInfo<KeysState>;
	media: ServiceStateInfo<MediaState>;
}

export interface InspectResult {
	inspectionId: string;
	sha256: string;
	id: string;
	name: string;
	version: string;
	description: string;
	permissions: Permission[];
	replaces: { version: string; granted: Permission[]; enabled: boolean } | null;
}

export type PluginUpdateResult =
	| { state: "current" }
	| { state: "updated"; version: string }
	| { state: "needs-consent"; inspectionId: string; version: string; added: Permission[] };

type Empty = Record<string, never>;

export interface BridgeMethods {
	"status.get": { params: Empty; result: AgentStatus };
	"plugins.setEnabled": { params: { id: string; enabled: boolean }; result: Empty };
	"plugins.inspect": { params: { source: string }; result: InspectResult };
	"plugins.install": { params: { inspectionId: string; acceptPermissions: Permission[] }; result: { id: string } };
	"plugins.uninstall": { params: { id: string }; result: Empty };
	"plugins.update": { params: { id: string }; result: PluginUpdateResult };
	"themes.styles": { params: Empty; result: { styles: { id: string; css: string }[] } };
	"themes.setEnabled": { params: { id: string; enabled: boolean }; result: Empty };
	"settings.set": { params: { key: "openAtLogin" | "autoUpdate"; value: boolean }; result: Empty };
	"build.rebuild": { params: { force?: boolean }; result: Empty };
	"update.check": { params: Empty; result: UpdateStatus };
	"update.apply": { params: Empty; result: Empty };
	"system.openPath": { params: { target: "plugins" | "themes" | "logs" }; result: Empty };
	"keys.watch": { params: { codes: string[] }; result: { unsupported: string[] } };
	"keys.install": { params: Empty; result: Empty };
	"media.duck": { params: { level: number }; result: Empty };
	"mcp.list": { params: { pluginId: string }; result: { servers: McpServerStatus[] } };
	"mcp.save": { params: { pluginId: string; server: McpServerConfig }; result: Empty };
	"mcp.remove": { params: { pluginId: string; id: string }; result: Empty };
	"mcp.connect": { params: { pluginId: string; id: string }; result: McpServerStatus };
	"mcp.tools": { params: { pluginId: string }; result: { tools: McpTool[] } };
	"mcp.call": { params: { pluginId: string; serverId: string; name: string; arguments: Record<string, unknown> }; result: McpToolResult };
	"sidebar.execute": { params: { command: SidebarCommand; rendererConnectionId?: number }; result: SidebarResult };
}

export type BridgeMethod = keyof BridgeMethods;

export const BRIDGE_METHODS: readonly BridgeMethod[] = [
	"status.get",
	"plugins.setEnabled",
	"plugins.inspect",
	"plugins.install",
	"plugins.uninstall",
	"plugins.update",
	"themes.styles",
	"themes.setEnabled",
	"settings.set",
	"build.rebuild",
	"update.check",
	"update.apply",
	"system.openPath",
	"keys.watch",
	"keys.install",
	"media.duck",
	"mcp.list",
	"mcp.save",
	"mcp.remove",
	"mcp.connect",
	"mcp.tools",
	"mcp.call",
	"sidebar.execute",
];

/** Client-side deadline per method. */
export function methodTimeoutMs(method: BridgeMethod): number {
	switch (method) {
		case "mcp.call":
			return 120_000;
		case "plugins.inspect":
		case "plugins.update":
			return 90_000;
		case "update.apply":
			return 180_000;
		default:
			return 30_000;
	}
}

export interface BridgeEvents {
	"status.changed": AgentStatus;
	"build.started": Empty;
	"build.finished": { buildKey: string; ok: boolean; appVersion: string; failed: string[] };
	"themes.changed": { styles: { id: string; css: string }[] };
	"keys.state": ServiceStateInfo<KeysState>;
	"keys.key": { code: string; down: boolean };
	"keys.chord": { code: string };
	"media.state": ServiceStateInfo<MediaState>;
	"update.status": UpdateStatus;
	"dev.reload": Empty;
	/** Sent before the agent restarts on a new `bridgePort`; the token is unchanged. */
	"bridge.moving": { port: number };
}

export type BridgeEvent = keyof BridgeEvents;

/** `/ <Product>/<version> Chrome/` in the user agent gives the app version. */
export const UA_APP_VERSION_PATTERN = /\s[^\s/]+\/(\d+\.\d+\.\d+[\w.-]*) Chrome\//;

export function appVersionFromUserAgent(userAgent: string): string | undefined {
	return UA_APP_VERSION_PATTERN.exec(userAgent)?.[1];
}

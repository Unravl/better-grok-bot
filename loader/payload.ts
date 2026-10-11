import type { BootPayload, BuildManifest, Platform, PluginLogger, PluginSource, PluginState, PluginStatus, ThemeInfo } from "../sdk/index.ts";
import { BOOT_GLOBAL, PLATFORMS } from "../sdk/index.ts";

/** The loader's one structural guard: an object whose fields are still unknown. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const SOURCES: Record<PluginSource, true> = { core: true, bundled: true, community: true, dev: true };
const STATES: Record<PluginState, true> = {
	active: true,
	disabled: true,
	"patch-failed": true,
	"runtime-failed": true,
	invalid: true,
	"unsupported-platform": true,
};

function isPluginStatus(value: unknown): value is PluginStatus {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.description === "string" &&
		typeof value.version === "string" &&
		typeof value.source === "string" &&
		Object.hasOwn(SOURCES, value.source) &&
		typeof value.state === "string" &&
		Object.hasOwn(STATES, value.state) &&
		isStringArray(value.errors) &&
		isStringArray(value.authors) &&
		Array.isArray(value.patches) &&
		value.patches.every((patch: unknown) => isRecord(patch) && isStringArray(patch.files)) &&
		isStringArray(value.permissions) &&
		isStringArray(value.granted) &&
		isRecord(value.settings) &&
		Object.values(value.settings).every((field) => isRecord(field) && typeof field.type === "string") &&
		typeof value.hasRuntime === "boolean"
	);
}

function isThemeInfo(value: unknown): value is ThemeInfo {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.enabled === "boolean" &&
		typeof value.valid === "boolean"
	);
}

function isManifest(value: unknown): value is BuildManifest {
	return (
		isRecord(value) &&
		typeof value.bgbVersion === "string" &&
		typeof value.buildKey === "string" &&
		PLATFORMS.some((platform) => platform === value.platform) &&
		typeof value.appVersion === "string" &&
		Array.isArray(value.plugins) &&
		value.plugins.every(isPluginStatus) &&
		Array.isArray(value.themes) &&
		value.themes.every(isThemeInfo)
	);
}

function isBootPayload(value: unknown): value is BootPayload {
	if (!isRecord(value) || !isManifest(value.manifest) || !isRecord(value.bridge) || !Array.isArray(value.styles)) return false;
	const { port, token } = value.bridge;
	return (
		typeof port === "number" &&
		Number.isInteger(port) &&
		port > 0 &&
		port < 65_536 &&
		typeof token === "string" &&
		token.length > 0 &&
		value.styles.every(
			(style: unknown) =>
				isRecord(style) &&
				typeof style.id === "string" &&
				(style.kind === "plugin" || style.kind === "theme") &&
				typeof style.css === "string",
		)
	);
}

export function deepFreeze<T>(value: T): T {
	if (isRecord(value) && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

function platformFromUserAgent(userAgent: string): Platform {
	if (/Windows/.test(userAgent)) return "win32";
	if (/Macintosh|Mac OS X/.test(userAgent)) return "darwin";
	return "linux";
}

export interface LoadedBoot {
	manifest: BuildManifest;
	/** Null when the payload is missing or malformed: the loader then runs without an agent connection. */
	bridge: { port: number; token: string } | null;
	styles: BootPayload["styles"];
}

/**
 * Reads the boot payload `build` wrote ahead of the loader in `boot.js`, removes the global
 * (the token must not stay reachable through it) and deep-freezes the manifest. A missing or
 * malformed payload yields an empty manifest, so plugin scripts get warnings instead of crashes.
 */
export function takeBootPayload(global: typeof globalThis, userAgent: string, log: PluginLogger): LoadedBoot {
	const payload: unknown = Reflect.get(global, BOOT_GLOBAL);
	// A `var` declaration makes the global non-configurable; overwrite what can't be deleted.
	if (!Reflect.deleteProperty(global, BOOT_GLOBAL)) Reflect.set(global, BOOT_GLOBAL, undefined);
	if (isBootPayload(payload)) {
		return {
			manifest: deepFreeze(payload.manifest),
			bridge: { port: payload.bridge.port, token: payload.bridge.token },
			styles: payload.styles.map((style) => ({ id: style.id, kind: style.kind, css: style.css })),
		};
	}
	log.error(
		payload === undefined
			? "no boot payload found (boot.js is incomplete); every plugin is ignored"
			: "boot payload is malformed; every plugin is ignored",
	);
	return {
		manifest: deepFreeze({
			bgbVersion: "unknown",
			buildFormat: 1,
			buildKey: "",
			platform: platformFromUserAgent(userAgent),
			appVersion: "unknown",
			appFingerprint: "",
			builtAt: "",
			plugins: [],
			themes: [],
		}),
		bridge: null,
		styles: [],
	};
}

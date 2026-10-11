import { randomBytes } from "node:crypto";
import { DEFAULT_BRIDGE_PORT, PERMISSIONS, type Permission } from "../sdk/index.ts";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import { withLock } from "./lock.ts";
import type { DataPaths } from "./paths.ts";

/** `DATA/config.json`. */
export interface Config {
	configVersion: 1;
	disabledPlugins: string[];
	enabledThemes: string[];
	grants: Record<string, Permission[]>;
	bridgePort: number;
	bridgeToken: string;
	autoUpdate: boolean;
	openAtLogin: boolean;
	appPath: string | null;
}

const CONFIG_MODE = 0o600;

/** base64url of 32 random bytes. */
export function newBridgeToken(): string {
	return randomBytes(32).toString("base64url");
}

export function defaultConfig(): Config {
	return {
		configVersion: 1,
		disabledPlugins: [],
		enabledThemes: [],
		grants: {},
		bridgePort: DEFAULT_BRIDGE_PORT,
		bridgeToken: newBridgeToken(),
		autoUpdate: true,
		openAtLogin: false,
		appPath: null,
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Type-checks a parsed `config.json`. A field that is absent takes its default, except `bridgeToken`
 * (a new token would silently orphan loaded pages); a present field of the wrong type throws an error
 * naming it. Unknown fields are dropped.
 */
export function parseConfig(value: unknown, source = "config.json"): Config {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${source}: expected a JSON object`);
	}
	const raw = value as Record<string, unknown>;
	const defaults = defaultConfig();
	const field = <K extends keyof Config>(key: K, check: (v: unknown) => v is Config[K], expected: string): Config[K] => {
		const v = raw[key];
		if (v === undefined) return defaults[key];
		if (!check(v)) throw new Error(`${source}: ${key} must be ${expected}`);
		return v;
	};
	if (raw.bridgeToken === undefined) throw new Error(`${source}: bridgeToken is missing`);
	return {
		configVersion: field("configVersion", (v): v is 1 => v === 1, "1"),
		disabledPlugins: field("disabledPlugins", isStringArray, "an array of strings"),
		enabledThemes: field("enabledThemes", isStringArray, "an array of strings"),
		grants: field(
			"grants",
			(v): v is Record<string, Permission[]> =>
				typeof v === "object" &&
				v !== null &&
				!Array.isArray(v) &&
				Object.values(v).every(
					(list) => isStringArray(list) && list.every((p) => (PERMISSIONS as readonly string[]).includes(p)),
				),
			`an object mapping plugin ids to arrays of ${PERMISSIONS.join("/")}`,
		),
		bridgePort: field(
			"bridgePort",
			(v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535,
			"an integer from 1 to 65535",
		),
		bridgeToken: field("bridgeToken", (v): v is string => typeof v === "string" && v.length > 0, "a non-empty string"),
		autoUpdate: field("autoUpdate", (v): v is boolean => typeof v === "boolean", "true or false"),
		openAtLogin: field("openAtLogin", (v): v is boolean => typeof v === "boolean", "true or false"),
		appPath: field("appPath", (v): v is string | null => v === null || typeof v === "string", "a string or null"),
	};
}

/** Reads and validates `config.json`; throws when it is missing or invalid. */
export async function readConfig(paths: DataPaths): Promise<Config> {
	const value = await readJsonFile(paths.config);
	if (value === undefined) throw new Error(`${paths.config} does not exist; run: bgb setup`);
	return parseConfig(value, paths.config);
}

/** Returns the config, creating it with defaults and a fresh bridge token when missing. */
export async function ensureConfig(paths: DataPaths): Promise<Config> {
	const existing = await readJsonFile(paths.config);
	if (existing !== undefined) return parseConfig(existing, paths.config);
	return withLock(paths, "config", async () => {
		const raced = await readJsonFile(paths.config);
		if (raced !== undefined) return parseConfig(raced, paths.config);
		const config = defaultConfig();
		await writeJsonAtomic(paths.config, config, { mode: CONFIG_MODE });
		return config;
	});
}

/**
 * Under the config lock: reads a fresh copy (created with defaults if missing), lets `fn` edit it in
 * place or return a replacement, validates the result and atomically replaces the file.
 */
export async function mutateConfig(
	paths: DataPaths,
	fn: (config: Config) => Config | undefined | void | Promise<Config | undefined | void>,
): Promise<Config> {
	return withLock(paths, "config", async () => {
		const current = await readJsonFile(paths.config);
		const draft = current === undefined ? defaultConfig() : parseConfig(current, paths.config);
		const next = parseConfig((await fn(draft)) ?? draft, "config");
		await writeJsonAtomic(paths.config, next, { mode: CONFIG_MODE });
		return next;
	});
}

import * as path from "node:path";
import type { McpServerConfig } from "../sdk/index.ts";
import { BgbError } from "./errors.ts";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import { withLock } from "./lock.ts";
import type { DataPaths } from "./paths.ts";

const STDIO_KEYS: Record<string, true> = {
	id: true,
	name: true,
	enabled: true,
	transport: true,
	command: true,
	args: true,
	env: true,
	cwd: true,
};
const REMOTE_KEYS: Record<string, true> = {
	id: true,
	name: true,
	enabled: true,
	transport: true,
	url: true,
	headers: true,
};

/** Marks diagnostics generated here, so unexpected exceptions cannot disclose input values. */
class McpValidationError extends BgbError {
	constructor(message: string) {
		super("bad-request", message);
	}
}

function record(value: unknown, diagnostic: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new McpValidationError(diagnostic);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new McpValidationError(diagnostic);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
			throw new McpValidationError(diagnostic);
		}
	}
	return value as Record<string, unknown>;
}

function array(value: unknown, diagnostic: string): unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
		throw new McpValidationError(diagnostic);
	}
	if (Reflect.ownKeys(value).length !== value.length + 1) throw new McpValidationError(diagnostic);
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, index);
		if (!descriptor?.enumerable || !("value" in descriptor)) throw new McpValidationError(diagnostic);
	}
	return value;
}

function string(value: unknown, field: string, nonblank: boolean): string {
	if (typeof value !== "string" || value.includes("\0") || (nonblank && value.trim().length === 0)) {
		throw new McpValidationError(`MCP server ${field} must be ${nonblank ? "a nonblank" : "a"} NUL-free string`);
	}
	return value;
}

function stringRecord(value: unknown, field: "env" | "headers"): Record<string, string> {
	const raw = record(value, `MCP server ${field} must be an object of strings`);
	const entries = Object.entries(raw);
	for (const [key, entry] of entries) {
		if (field === "env" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.exec(key)?.[0] !== key) {
			throw new McpValidationError("MCP server env keys must be valid environment variable names");
		}
		if (typeof entry !== "string" || entry.includes("\0")) {
			throw new McpValidationError(`MCP server ${field} values must be NUL-free strings`);
		}
	}
	return Object.fromEntries(entries) as Record<string, string>;
}

/** Validates the complete transport-specific configuration; only an absent enabled field defaults. */
export function parseMcpServerConfig(value: unknown): McpServerConfig {
	try {
		const raw = record(value, "MCP server must be a JSON object");
		const transport = raw.transport;
		if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
			throw new McpValidationError("MCP server transport must be stdio, http, or sse");
		}
		const allowed = transport === "stdio" ? STDIO_KEYS : REMOTE_KEYS;
		if (Object.keys(raw).some((key) => !Object.hasOwn(allowed, key))) {
			throw new McpValidationError("MCP server contains unsupported configuration fields");
		}
		const id = raw.id;
		if (typeof id !== "string" || /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.exec(id)?.[0] !== id) {
			throw new McpValidationError("MCP server id must be 1-64 letters, digits, underscores, or hyphens, starting with a letter or digit");
		}
		const name = raw.name;
		if (typeof name !== "string" || name.trim().length === 0) {
			throw new McpValidationError("MCP server name must be a nonblank string");
		}
		const enabled = Object.hasOwn(raw, "enabled") ? raw.enabled : false;
		if (typeof enabled !== "boolean") throw new McpValidationError("MCP server enabled must be true or false");
		const common = { id, name, enabled };
		if (transport === "stdio") {
			const command = string(raw.command, "command", true);
			const args = array(raw.args, "MCP server args must be an array of NUL-free strings").map((entry) =>
				string(entry, "args entries", false),
			);
			const env = stringRecord(raw.env, "env");
			const cwd = Object.hasOwn(raw, "cwd") ? string(raw.cwd, "cwd", true) : undefined;
			return { ...common, transport, command, args, env, ...(cwd === undefined ? {} : { cwd }) };
		}
		const url = raw.url;
		if (typeof url !== "string") throw new McpValidationError("MCP server url must be an HTTP(S) URL without credentials or a fragment");
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new McpValidationError("MCP server url must be an HTTP(S) URL without credentials or a fragment");
		}
		if (
			(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
			parsed.username !== "" || parsed.password !== "" || url.includes("#")
		) {
			throw new McpValidationError("MCP server url must be an HTTP(S) URL without credentials or a fragment");
		}
		const headers = stringRecord(raw.headers, "headers");
		try {
			new Headers(headers);
		} catch {
			throw new McpValidationError("MCP server headers must contain valid HTTP header names and values");
		}
		return { ...common, transport, url, headers };
	} catch (error) {
		if (error instanceof McpValidationError) throw error;
		throw new McpValidationError("MCP server must contain valid JSON configuration fields");
	}
}

const ARGUMENTS_DIAGNOSTIC = "MCP arguments must be a JSON object containing only finite JSON values, without cycles or custom prototypes";

function validateJsonValue(value: unknown, ancestors: Set<object>): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (typeof value !== "object" || value === null || ancestors.has(value)) {
		throw new McpValidationError(ARGUMENTS_DIAGNOSTIC);
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			for (const entry of array(value, ARGUMENTS_DIAGNOSTIC)) validateJsonValue(entry, ancestors);
		} else {
			for (const entry of Object.values(record(value, ARGUMENTS_DIAGNOSTIC))) validateJsonValue(entry, ancestors);
		}
	} finally {
		ancestors.delete(value);
	}
}

/** Accepts bridge JSON objects without allowing lossy JSON coercions, accessors, or toJSON methods. */
export function parseMcpArguments(value: unknown): Record<string, unknown> {
	try {
		const args = record(value, ARGUMENTS_DIAGNOSTIC);
		validateJsonValue(args, new Set());
		return args;
	} catch (error) {
		if (error instanceof McpValidationError) throw error;
		throw new McpValidationError(ARGUMENTS_DIAGNOSTIC);
	}
}

function parseDocument(value: unknown): McpServerConfig[] {
	const document = record(value, "mcp.json must be a JSON object");
	if (Object.keys(document).some((key) => key !== "version" && key !== "servers")) {
		throw new McpValidationError("mcp.json contains unsupported configuration fields");
	}
	if (document.version !== 1) throw new McpValidationError("mcp.json version must be 1");
	const servers = array(document.servers, "mcp.json servers must be an array").map(parseMcpServerConfig);
	const ids = new Set<string>();
	for (const server of servers) {
		if (ids.has(server.id)) throw new McpValidationError("mcp.json server ids must be unique");
		ids.add(server.id);
	}
	return servers;
}

/** Atomic writers allow unlocked reads; a missing file means no configured servers. */
export async function readMcpConfig(paths: DataPaths): Promise<McpServerConfig[]> {
	try {
		const value = await readJsonFile(path.join(paths.root, "mcp.json"));
		return value === undefined ? [] : parseDocument(value);
	} catch (error) {
		throw new BgbError("unavailable", error instanceof McpValidationError ? error.message : "mcp.json could not be read as valid JSON");
	}
}

/** Holds the shared config lock only for fresh I/O, synchronous edits, validation, and atomic writing. */
export async function mutateMcpConfig(
	paths: DataPaths,
	fn: (servers: McpServerConfig[]) => void,
): Promise<McpServerConfig[]> {
	try {
		return await withLock(paths, "config", async () => {
			const servers = await readMcpConfig(paths);
			fn(servers);
			const next = parseDocument({ version: 1, servers });
			await writeJsonAtomic(path.join(paths.root, "mcp.json"), { version: 1, servers: next }, { mode: 0o600 });
			return next;
		});
	} catch (error) {
		if (error instanceof BgbError) throw error;
		throw new BgbError("unavailable", "mcp.json could not be updated");
	}
}

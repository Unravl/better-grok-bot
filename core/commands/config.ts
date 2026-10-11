import { existsSync } from "node:fs";
import * as path from "node:path";
import { readLiveAgent } from "../agent-record.ts";
import { mutateConfig, readConfig } from "../config.ts";
import { UsageError, parseArgs, subcommand } from "./args.ts";
import type { CommandEnv } from "./env.ts";

const USAGE = "bgb config get <key> | bgb config set <key> <value>   (keys: bridgePort, autoUpdate, openAtLogin, appPath)";
const KEYS = ["bridgePort", "autoUpdate", "openAtLogin", "appPath"] as const;
type ConfigKey = (typeof KEYS)[number];

function asKey(value: string | undefined): ConfigKey {
	const key = KEYS.find((candidate) => candidate === value);
	if (!key) throw new UsageError(`unknown config key "${value}"\nusage: ${USAGE}`);
	return key;
}

function parseBoolean(key: string, value: string): boolean {
	if (value === "true") return true;
	if (value === "false") return false;
	throw new UsageError(`${key} must be true or false`);
}

/** Unprivileged TCP ports only: the agent binds 127.0.0.1 as the user. */
function parsePort(value: string): number {
	const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isInteger(port) || port < 1024 || port > 65535) {
		throw new UsageError("bridgePort must be an integer from 1024 to 65535");
	}
	return port;
}

export async function runConfig(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const [sub, rest] = subcommand(argv, ["get", "set"], USAGE);
	if (sub === "get") {
		const key = asKey(parseArgs(rest, { min: 1, usage: "bgb config get <key>" }).positionals[0]);
		const config = await readConfig((await env.context()).paths);
		env.io.out(String(config[key]));
		return 0;
	}
	const [rawKey, value = ""] = parseArgs(rest, { min: 2, usage: "bgb config set <key> <value>" }).positionals;
	const key = asKey(rawKey);
	const ctx = await env.context();
	let shown: string;
	switch (key) {
		case "bridgePort": {
			const port = parsePort(value);
			await mutateConfig(ctx.paths, (config) => {
				config.bridgePort = port;
			});
			shown = String(port);
			break;
		}
		case "autoUpdate":
		case "openAtLogin": {
			const flag = parseBoolean(key, value);
			await mutateConfig(ctx.paths, (config) => {
				config[key] = flag;
			});
			shown = String(flag);
			break;
		}
		case "appPath": {
			const appPath = value === "" || value === "null" ? null : path.resolve(value);
			if (appPath !== null && !existsSync(appPath)) throw new Error(`${appPath} does not exist`);
			await mutateConfig(ctx.paths, (config) => {
				config.appPath = appPath;
			});
			shown = String(appPath);
			break;
		}
	}
	env.io.out(`${key} = ${shown}`);
	if (key === "bridgePort" && (await readLiveAgent(ctx.paths))) {
		env.io.out("The agent rebuilds and restarts on the new port; open Grok Bot windows follow it.");
	}
	return 0;
}

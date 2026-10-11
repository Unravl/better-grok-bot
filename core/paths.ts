import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { RENDERER_URL_QUERY } from "../sdk/index.ts";

/** Every location inside one BGB data directory (`DATA`). */
export interface DataPaths {
	readonly root: string;
	readonly bin: string;
	readonly binPrevious: string;
	readonly config: string;
	readonly state: string;
	readonly agentRecord: string;
	readonly locks: string;
	readonly plugins: string;
	readonly devPlugins: string;
	readonly themes: string;
	readonly builds: string;
	readonly current: string;
	readonly helpers: string;
	readonly cache: string;
	readonly migrated: string;
	readonly logs: string;
}

export function dataPaths(root: string): DataPaths {
	const resolved = path.resolve(root);
	const at = (...parts: string[]): string => path.join(resolved, ...parts);
	return Object.freeze({
		root: resolved,
		bin: at("bin"),
		binPrevious: at("bin", "previous"),
		config: at("config.json"),
		state: at("state.json"),
		agentRecord: at("agent.pid"),
		locks: at("locks"),
		plugins: at("plugins"),
		devPlugins: at("dev-plugins.json"),
		themes: at("themes"),
		builds: at("builds"),
		current: at("current"),
		helpers: at("helpers"),
		cache: at("cache"),
		migrated: at("migrated"),
		logs: at("logs"),
	});
}

/** The per-OS default `DATA`, ignoring `BGB_DATA_DIR` (only `createContext` reads that). */
export function defaultDataDir(
	platform: NodeJS.Platform = process.platform,
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	switch (platform) {
		case "darwin":
			return path.posix.join(home, "Library", "Application Support", "BetterGrokBot");
		case "win32":
			return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "BetterGrokBot");
		default:
			return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, ".local", "share"), "BetterGrokBot");
	}
}

/** Creates `DATA` (mode 0700) plus `locks/` and `logs/`; tightens an existing `DATA` to 0700 on macOS/Linux. */
export async function ensureDataDir(paths: DataPaths): Promise<void> {
	await mkdir(paths.root, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await chmod(paths.root, 0o700);
	await mkdir(paths.locks, { recursive: true });
	await mkdir(paths.logs, { recursive: true });
}

/** The hook value: `file://…/current/renderer/index.html?bgb`. */
export function rendererUrl(paths: DataPaths): string {
	return `${pathToFileURL(path.join(paths.current, "renderer", "index.html")).href}?${RENDERER_URL_QUERY}`;
}

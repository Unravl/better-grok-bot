import { spawn } from "node:child_process";
import * as path from "node:path";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import type { Logger } from "../log.ts";
import { BGB_COMPILED } from "../version.ts";

/** launchd label of the agent job. */
export const AGENT_LABEL = "io.github.unravl.bettergrokbot.agent";

/** True when launchd runs this agent (its `KeepAlive` starts a fresh one after we exit). */
export function underLaunchd(env: Record<string, string | undefined> = process.env): boolean {
	return env.XPC_SERVICE_NAME === AGENT_LABEL;
}

/**
 * Spawns a detached `bgb agent --replace` for `DATA` (Windows through `bgbw.exe`, so no console window
 * appears). From a checkout, re-runs this script with Bun.
 */
export function respawnAgent(ctx: CoreContext): void {
	const argv = BGB_COMPILED
		? [path.join(ctx.paths.bin, ctx.platform.id === "win32" ? "bgbw.exe" : ctx.platform.binName()), "agent", "--replace"]
		: [process.execPath, ...process.argv.slice(1, 2), "agent", "--replace"];
	spawnDetached(argv, { BGB_DATA_DIR: ctx.paths.root }, ctx.log);
}

/** Starts a process that outlives this one (no stdio, own process group, hidden window on Windows). */
export function spawnDetached(argv: readonly string[], env: Record<string, string>, log: Logger): void {
	const [file, ...args] = argv;
	if (!file) throw new Error("spawnDetached: empty argv");
	const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...env } });
	child.on("error", (error) => log.error(`cannot start ${file}: ${errorMessage(error)}`));
	child.unref();
}

import { randomBytes } from "node:crypto";
import { rm, symlink } from "node:fs/promises";
import * as path from "node:path";
import { renameReplacing } from "../json-file.ts";
import type { DataPaths } from "../paths.ts";
import { isAlive } from "../proc.ts";
import { type HookStatus, isOwnHookValue } from "./types.ts";

export interface CommandResult {
	/** Exit code; 127 when the program could not be started. */
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	cwd?: string;
	/** Replaces the child environment (defaults to `process.env`). */
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
}

/** Runs a program to completion and captures its output. Never throws. */
export type CommandRunner = (argv: string[], opts?: RunOptions) => Promise<CommandResult>;

/** Starts a program detached from this process (no stdio, not awaited). Throws when it cannot start. */
export type DetachedSpawner = (argv: string[], opts: { env: Record<string, string | undefined>; cwd?: string }) => void;

export const runCommand: CommandRunner = async (argv, opts = {}) => {
	try {
		const proc = Bun.spawn(argv, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			timeout: opts.timeoutMs ?? 60_000,
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} catch (error) {
		return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
};

export const spawnDetached: DetachedSpawner = (argv, opts) => {
	const proc = Bun.spawn(argv, {
		cwd: opts.cwd,
		env: opts.env,
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
		windowsHide: true,
	});
	proc.unref();
};

/** `stderr`, else `stdout`, else the exit code: the reason a command failed. */
export function failureText(result: CommandResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
}

/** Polls until `pid` is gone; true when it exited within `timeoutMs`. */
export async function waitForExit(pid: number, timeoutMs: number, pollMs = 100): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!isAlive(pid)) return true;
		if (Date.now() >= deadline) return false;
		await Bun.sleep(pollMs);
	}
}

/**
 * Status of a global-variable hook (macOS launchctl, Windows user env) from the current value:
 * our URL → active; unset or an owned value (an older grok-mods URL, replaced on install) → absent;
 * anything else → conflict.
 */
export function hookStatusFromValue(value: string | null, url: string): HookStatus {
	if (value === null || value === "") return { state: "absent" };
	if (value === url) return { state: "active" };
	if (isOwnHookValue(value, url)) return { state: "absent" };
	return { state: "conflict", value };
}

/** macOS/Linux `current`: a temp symlink renamed over the old one, so readers never see it missing. */
export async function pointCurrentSymlink(paths: DataPaths, buildDir: string): Promise<void> {
	const temp = path.join(path.dirname(paths.current), `.current-${randomBytes(6).toString("hex")}`);
	await symlink(buildDir, temp, "dir");
	try {
		await renameReplacing(temp, paths.current);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

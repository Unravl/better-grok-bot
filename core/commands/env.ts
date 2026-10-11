import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Permission } from "../../sdk/index.ts";
import { type AgentHealth, readLiveAgent } from "../agent-record.ts";
import type { CoreContext } from "../context.ts";
import { readState } from "../state.ts";
import { BGB_COMPILED } from "../version.ts";
import { UsageError } from "./args.ts";

/** Where commands write. `out` and `err` append a newline; `write` does not. */
export interface CliIo {
	out(line: string): void;
	err(line: string): void;
	write(chunk: string): void;
}

export const consoleIo: CliIo = {
	out: (line) => console.log(line),
	err: (line) => console.error(line),
	write: (chunk) => {
		process.stdout.write(chunk);
	},
};

export interface CommandEnv {
	readonly io: CliIo;
	/** Created on first use, so commands that never touch `DATA` (`check`, `--version`) don't create it. */
	context(): Promise<CoreContext>;
}

/** One-line meaning of each permission, shown before asking for consent. */
export const PERMISSION_MEANINGS: Readonly<Record<Permission, string>> = {
	keys: "listen to a key while Grok Bot is in the background",
	media: "lower other apps' volume",
	mcp: "manage MCP servers and run their tools",
};

/** The installed binary the agent and autostart run: `DATA/bin/bgb[.exe]`, else this binary when compiled. */
export function installedBinary(ctx: CoreContext): string {
	const installed = path.join(ctx.paths.bin, ctx.platform.binName());
	if (existsSync(installed)) return installed;
	if (BGB_COMPILED) return process.execPath;
	throw new Error(`no bgb binary in ${ctx.paths.bin}; run: bgb setup`);
}

/** Build keys of connected renderers; `state.renderers` is stale without a live agent, so then none. */
export async function liveRendererKeys(ctx: CoreContext): Promise<string[]> {
	if (!(await readLiveAgent(ctx.paths))) return [];
	return [...new Set((await readState(ctx.paths)).renderers.map((renderer) => renderer.buildKey))];
}

/** `GET /health` on the agent port; `null` when nothing (or something other than BGB) answers. */
export async function fetchHealth(port: number, timeoutMs = 1_000): Promise<AgentHealth | null> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) return null;
		const body = (await response.json()) as Partial<AgentHealth>;
		if (body.name !== "better-grok-bot" || typeof body.version !== "string" || typeof body.pid !== "number") return null;
		return { name: body.name, version: body.version, pid: body.pid };
	} catch {
		return null;
	}
}

/**
 * `--yes` → true. Otherwise asks on the terminal (the prompt module appends `[y/N]`); without a terminal
 * the command must be rerun with `--yes`.
 */
export async function confirmAction(question: string, yes: boolean): Promise<boolean> {
	if (yes) return true;
	const prompt = await import("../setup/prompt.ts");
	if (!prompt.isInteractive()) throw new UsageError(`${question} — no terminal to ask; pass --yes to confirm`);
	return prompt.confirm(question, false);
}

/** Printed after a config change the agent applies by rebuilding. */
export async function applyHint(ctx: CoreContext): Promise<string> {
	return (await readLiveAgent(ctx.paths))
		? "The agent rebuilds now; then use Reload to apply in Grok Bot → Settings → General → Better Grok Bot."
		: "The agent is not running; it applies this when it starts (bgb start), or run: bgb build";
}

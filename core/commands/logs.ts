import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { DataPaths } from "../paths.ts";
import { parseArgs } from "./args.ts";
import type { CommandEnv } from "./env.ts";

export function agentLogFile(paths: DataPaths): string {
	return path.join(paths.logs, "agent.log");
}

async function sizeOf(file: string): Promise<number> {
	try {
		return (await stat(file)).size;
	} catch {
		return 0;
	}
}

/**
 * Writes what is appended to `file` from byte `from` on, polling every `intervalMs` until `signal` aborts.
 * A file that shrank was rotated: reading restarts at its beginning.
 */
export async function followFile(
	file: string,
	write: (chunk: string) => void,
	signal: AbortSignal,
	opts: { from?: number; intervalMs?: number } = {},
): Promise<void> {
	const decoder = new TextDecoder();
	let offset = opts.from ?? 0;
	while (!signal.aborted) {
		const size = await sizeOf(file);
		if (size < offset) offset = 0;
		if (size > offset) {
			const bytes = new Uint8Array(await Bun.file(file).slice(offset, size).arrayBuffer());
			offset += bytes.byteLength;
			const text = decoder.decode(bytes, { stream: true });
			if (text) write(text);
		}
		await new Promise<void>((resolve) => {
			const done = (): void => {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, opts.intervalMs ?? 500);
			signal.addEventListener("abort", done);
		});
	}
}

/** An AbortSignal that fires on Ctrl+C (SIGINT) or SIGTERM; `dispose` removes the handlers. */
export function interruptSignal(): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const abort = (): void => controller.abort();
	process.on("SIGINT", abort);
	process.on("SIGTERM", abort);
	return {
		signal: controller.signal,
		dispose: () => {
			process.off("SIGINT", abort);
			process.off("SIGTERM", abort);
		},
	};
}

export async function runLogs(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, { flags: { "--follow": "boolean" }, aliases: { "-f": "--follow" }, usage: "bgb logs [-f]" });
	const file = agentLogFile((await env.context()).paths);
	const size = await sizeOf(file);
	if (size > 0) env.io.write(await Bun.file(file).slice(0, size).text());
	else if (!args.has("--follow")) env.io.err(`bgb: no log yet at ${file}`);
	if (!args.has("--follow")) return 0;
	const interrupt = interruptSignal();
	try {
		await followFile(file, env.io.write, interrupt.signal, { from: size });
	} finally {
		interrupt.dispose();
	}
	return 0;
}

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import { errorMessage } from "./errors.ts";
import type { DataPaths } from "./paths.ts";

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	debug(message: string): void;
}

const ROTATE_BYTES = 5 * 1024 * 1024;
const KEEP = 2;

export const nullLogger: Logger = Object.freeze({
	info() {},
	warn() {},
	error() {},
	debug() {},
});

/** Writes `[bgb] message` lines to stderr (stdout stays clean for command output such as `--json`). */
export function createConsoleLogger(opts: { debug?: boolean } = {}): Logger {
	const debug = opts.debug ?? process.env.BGB_DEBUG === "1";
	return {
		info: (message) => console.error(`[bgb] ${message}`),
		warn: (message) => console.error(`[bgb] warning: ${message}`),
		error: (message) => console.error(`[bgb] error: ${message}`),
		debug: (message) => {
			if (debug) console.error(`[bgb] debug: ${message}`);
		},
	};
}

/**
 * Appends timestamped lines to `DATA/logs/agent.log`, shared by the agent and CLI processes. At 5 MB the
 * file rotates to `agent.1.log` (and that to `agent.2.log`). Logging never throws.
 */
export function createFileLogger(
	paths: DataPaths,
	opts: { echo?: boolean; debug?: boolean; maxBytes?: number } = {},
): Logger {
	const file = path.join(paths.logs, "agent.log");
	const maxBytes = opts.maxBytes ?? ROTATE_BYTES;
	const debug = opts.debug ?? process.env.BGB_DEBUG === "1";
	const echo = opts.echo ? createConsoleLogger({ debug }) : undefined;
	let size: number | undefined;

	const rotate = (): void => {
		rmSync(path.join(paths.logs, `agent.${KEEP}.log`), { force: true });
		for (let i = KEEP - 1; i >= 1; i--) {
			try {
				renameSync(path.join(paths.logs, `agent.${i}.log`), path.join(paths.logs, `agent.${i + 1}.log`));
			} catch {}
		}
		renameSync(file, path.join(paths.logs, "agent.1.log"));
	};

	const write = (level: string, message: string): void => {
		const line = `${new Date().toISOString()} ${level.padEnd(5)} [${process.pid}] ${message}\n`;
		try {
			if (size === undefined) {
				mkdirSync(paths.logs, { recursive: true });
				size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
			}
			if (size + line.length > maxBytes) {
				// Another process may have rotated already; trust the file, not our counter.
				const actual = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
				if (actual + line.length > maxBytes && actual > 0) rotate();
				size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
			}
			appendFileSync(file, line);
			size += Buffer.byteLength(line);
		} catch (error) {
			console.error(`[bgb] cannot write ${file}: ${errorMessage(error)}`);
		}
	};

	return {
		info(message) {
			write("INFO", message);
			echo?.info(message);
		},
		warn(message) {
			write("WARN", message);
			echo?.warn(message);
		},
		error(message) {
			write("ERROR", message);
			echo?.error(message);
		},
		debug(message) {
			if (!debug) return;
			write("DEBUG", message);
			echo?.debug(message);
		},
	};
}

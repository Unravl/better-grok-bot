/** Helpers shared by the repository scripts (run with Bun from a checkout). */
import { createHash } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import * as path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");

export class ScriptError extends Error {
	constructor(
		message: string,
		readonly exitCode = 1,
	) {
		super(message);
		this.name = "ScriptError";
	}
}

/** Runs `main` and maps a thrown error to `<script>: <message>` on stderr plus its exit code. */
export async function runMain(name: string, main: () => Promise<number | void>): Promise<never> {
	try {
		const code = await main();
		process.exit(code ?? 0);
	} catch (error) {
		const code = error instanceof ScriptError ? error.exitCode : 1;
		console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(code);
	}
}

export interface RunOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	/** Pass the child's stdout/stderr through instead of capturing them. */
	inherit?: boolean;
	/** Return the result on a non-zero exit instead of throwing. */
	allowFail?: boolean;
	timeoutMs?: number;
	stdin?: "ignore" | "inherit" | Uint8Array;
	windowsVerbatimArguments?: boolean;
}

export interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Spawns `cmd`, waits for it and returns its output; throws on a non-zero exit unless `allowFail`. */
export async function run(cmd: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
	const env = opts.env ? mergeEnv(opts.env) : undefined;
	const proc = Bun.spawn([...cmd], {
		cwd: opts.cwd,
		env,
		stdin: opts.stdin ?? "ignore",
		stdout: opts.inherit ? "inherit" : "pipe",
		stderr: opts.inherit ? "inherit" : "pipe",
		windowsHide: true,
		windowsVerbatimArguments: opts.windowsVerbatimArguments,
		timeout: opts.timeoutMs,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : Promise.resolve(""),
		proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : Promise.resolve(""),
		proc.exited,
	]);
	if (exitCode !== 0 && !opts.allowFail) {
		const detail = (stderr.trim() || stdout.trim()).split("\n").slice(-20).join("\n");
		throw new ScriptError(`${cmd.join(" ")} exited with ${exitCode}${detail ? `:\n${detail}` : ""}`);
	}
	return { exitCode, stdout, stderr };
}

/** `process.env` overlaid with `extra`; `undefined` values remove a variable. */
export function mergeEnv(extra: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	for (const [key, value] of Object.entries(extra)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

export function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(file: string): Promise<string> {
	const hash = createHash("sha256");
	const reader = Bun.file(file).stream().getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		hash.update(value);
	}
	return hash.digest("hex");
}

/** Downloads `url` to `dest` (via `<dest>.part` + rename), retrying network failures up to 3 times. */
export async function download(url: string, dest: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		const part = `${dest}.part`;
		try {
			const response = await fetch(url, { redirect: "follow" });
			if (!response.ok) throw new ScriptError(`GET ${url} → HTTP ${response.status}`);
			await Bun.write(part, response);
			await rename(part, dest);
			return;
		} catch (error) {
			lastError = error;
			await rm(part, { force: true });
			if (error instanceof ScriptError && /HTTP 4\d\d/.test(error.message)) break;
			if (attempt < 3) await Bun.sleep(2_000 * attempt);
		}
	}
	throw lastError instanceof Error ? lastError : new ScriptError(String(lastError));
}

/** Parses `SHA256SUMS` (`<hex>  <name>` or `<hex> *<name>`) into name → hex. */
export function parseSums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
		if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
	}
	return sums;
}

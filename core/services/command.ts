import { errorMessage } from "../errors.ts";

export interface CommandResult {
	/** Exit code; 127 when the program could not be started. */
	code: number;
	stdout: string;
	stderr: string;
}

export interface CommandOptions {
	timeoutMs?: number;
	cwd?: string;
	/** Merged over `process.env`. */
	env?: Record<string, string>;
}

/** Runs a program to completion and captures its output. Never throws. Injectable so tests never run real `launchctl`/`pactl`. */
export type CommandRunner = (argv: readonly string[], opts?: CommandOptions) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (argv, opts = {}) => {
	try {
		const proc = Bun.spawn([...argv], {
			cwd: opts.cwd,
			env: opts.env ? { ...process.env, ...opts.env } : process.env,
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
		return { code: 127, stdout: "", stderr: errorMessage(error) };
	}
};

/** Like {@link CommandRunner} but throws `"<program> failed: <stderr>"` on a non-zero exit. */
export async function mustRun(run: CommandRunner, argv: readonly string[], opts?: CommandOptions): Promise<string> {
	const result = await run(argv, opts);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`${argv.slice(0, 2).join(" ")} failed: ${detail}`);
	}
	return result.stdout;
}

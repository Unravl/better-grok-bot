import { homedir, userInfo } from "node:os";
import { runPowerShell } from "../powershell.ts";
import { confirm, isInteractive } from "./prompt.ts";

export interface ExecResult {
	/** `-1` when the process was killed (timeout) instead of exiting. */
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * The parts of the user's machine setup, uninstall, migration and restart touch outside `DATA` and the
 * platform adapter. Tests pass a host with a temp home, a recording command runner and scripted answers.
 */
export interface SetupHost {
	readonly home: string;
	/** POSIX uid (`gui/<uid>` launchd domain); `-1` on Windows. */
	readonly uid: number;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Runs a command without a shell; never throws for a non-zero exit. */
	exec(argv: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;
	/** Runs a Windows PowerShell script; throws on a non-zero exit. */
	powershell(script: string): Promise<string>;
	/** One line of command output (stdout). */
	print(line: string): void;
	/** One line of error output (stderr). */
	printError(line: string): void;
	isInteractive(): boolean;
	confirm(question: string, defaultYes: boolean): Promise<boolean>;
}

/** Spawns `argv` with stdin closed and collects its output. */
export async function execCommand(argv: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
	const proc = Bun.spawn(argv, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		timeout: opts.timeoutMs ?? 30_000,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code: proc.signalCode === null ? code : -1, stdout, stderr };
}

/** The real machine: `os.homedir()`, `process.env`, `Bun.spawn`, stdout/stderr and the terminal. */
export function systemHost(): SetupHost {
	return {
		home: homedir(),
		uid: process.platform === "win32" ? -1 : userInfo().uid,
		env: process.env,
		exec: execCommand,
		powershell: runPowerShell,
		print: (line) => console.log(line),
		printError: (line) => console.error(line),
		isInteractive,
		confirm,
	};
}

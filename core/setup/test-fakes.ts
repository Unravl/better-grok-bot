import type { Platform } from "../../sdk/index.ts";
import type { PlatformAdapter } from "../platform/types.ts";
import type { ExecResult, SetupHost } from "./host.ts";

/** Test doubles shared by the `core/setup` tests. */

export interface Call {
	name: string;
	args: unknown[];
}

/**
 * A platform adapter whose methods succeed with neutral results unless overridden, and that appends
 * every call (except `binName`) to `calls`.
 */
export function recordingAdapter(calls: Call[], overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
	const id: Platform = overrides.id ?? (process.platform as Platform);
	const impl: PlatformAdapter = {
		id,
		locateApp: async () => {
			throw new Error("locateApp is not faked");
		},
		findRunningApp: async () => undefined,
		quitApp: async () => true,
		launchApp: async () => {},
		hookInstall: async (url) => ({ kind: id === "win32" ? "user-env" : "launchctl", value: url }),
		hookRemove: async () => "removed",
		hookStatus: async () => ({ state: "absent" }),
		autostartInstall: async () => {},
		autostartRemove: async () => {},
		startAgent: async () => {},
		stopAgent: async () => {},
		pointCurrent: async () => {},
		notify: async () => {},
		openPath: async () => {},
		binName: () => (id === "win32" ? "bgb.exe" : "bgb"),
		...overrides,
	};
	const record =
		<A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
		(...args: A): R => {
			calls.push({ name, args });
			return fn(...args);
		};
	return {
		id,
		locateApp: record("locateApp", impl.locateApp),
		findRunningApp: record("findRunningApp", impl.findRunningApp),
		quitApp: record("quitApp", impl.quitApp),
		launchApp: record("launchApp", impl.launchApp),
		hookInstall: record("hookInstall", impl.hookInstall),
		hookRemove: record("hookRemove", impl.hookRemove),
		hookStatus: record("hookStatus", impl.hookStatus),
		autostartInstall: record("autostartInstall", impl.autostartInstall),
		autostartRemove: record("autostartRemove", impl.autostartRemove),
		startAgent: record("startAgent", impl.startAgent),
		stopAgent: record("stopAgent", impl.stopAgent),
		pointCurrent: record("pointCurrent", impl.pointCurrent),
		notify: record("notify", impl.notify),
		openPath: record("openPath", impl.openPath),
		binName: impl.binName,
	};
}

export interface FakeHost extends SetupHost {
	readonly out: string[];
	readonly err: string[];
	/** Every `exec` argv, in order. */
	readonly commands: string[][];
	/** Every PowerShell script, in order. */
	readonly scripts: string[];
	/** Every question asked through `confirm`, in order. */
	readonly questions: string[];
}

export interface FakeHostOptions {
	env?: Record<string, string | undefined>;
	interactive?: boolean;
	/** Answers for successive `confirm` calls; once exhausted, every answer is no. */
	answers?: boolean[];
	/** Result for a command; `undefined` → exit 0 with no output. */
	exec?: (argv: string[]) => ExecResult | undefined;
	powershell?: (script: string) => string;
}

/** A host with `home` as the home dir that records output, commands and prompts instead of performing them. */
export function fakeHost(home: string, opts: FakeHostOptions = {}): FakeHost {
	const out: string[] = [];
	const err: string[] = [];
	const commands: string[][] = [];
	const scripts: string[] = [];
	const questions: string[] = [];
	const answers = [...(opts.answers ?? [])];
	return {
		home,
		uid: 501,
		env: opts.env ?? { PATH: `${home}/.local/bin:/usr/bin:/bin` },
		out,
		err,
		commands,
		scripts,
		questions,
		exec: async (argv) => {
			commands.push(argv);
			return opts.exec?.(argv) ?? { code: 0, stdout: "", stderr: "" };
		},
		powershell: async (script) => {
			scripts.push(script);
			return opts.powershell?.(script) ?? "";
		},
		print: (line) => out.push(line),
		printError: (line) => err.push(line),
		isInteractive: () => opts.interactive ?? false,
		confirm: async (question) => {
			questions.push(question);
			return answers.shift() ?? false;
		},
	};
}

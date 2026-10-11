/** Fakes shared by the CLI tests. */
import type { CoreContext } from "../context.ts";
import type { PlatformAdapter } from "../platform/types.ts";
import type { CliIo, CommandEnv } from "./env.ts";

export interface CapturedIo extends CliIo {
	readonly stdout: string[];
	readonly stderr: string[];
}

export function captureIo(): CapturedIo {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		out: (line) => stdout.push(line),
		err: (line) => stderr.push(line),
		write: (chunk) => stdout.push(chunk),
	};
}

/** Every method throws unless overridden, so a test notices any platform call it didn't expect. */
export function fakePlatform(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
	const unexpected = (method: string) => async (): Promise<never> => {
		throw new Error(`unexpected platform call ${method}`);
	};
	return {
		id: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
		locateApp: unexpected("locateApp"),
		findRunningApp: unexpected("findRunningApp"),
		quitApp: unexpected("quitApp"),
		launchApp: unexpected("launchApp"),
		hookInstall: unexpected("hookInstall"),
		hookRemove: unexpected("hookRemove"),
		hookStatus: unexpected("hookStatus"),
		autostartInstall: unexpected("autostartInstall"),
		autostartRemove: unexpected("autostartRemove"),
		startAgent: unexpected("startAgent"),
		stopAgent: unexpected("stopAgent"),
		pointCurrent: unexpected("pointCurrent"),
		notify: async () => {},
		openPath: unexpected("openPath"),
		binName: () => (process.platform === "win32" ? "bgb.exe" : "bgb"),
		...overrides,
	};
}

export function commandEnv(io: CliIo, ctx: CoreContext | undefined): CommandEnv {
	return {
		io,
		context: async () => {
			if (!ctx) throw new Error("this command must not need a context");
			return ctx;
		},
	};
}

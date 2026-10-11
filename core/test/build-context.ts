import { randomBytes } from "node:crypto";
import { mkdtemp, rename, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Platform } from "../../sdk/index.ts";
import { type CoreContext, createContext } from "../context.ts";
import { nullLogger } from "../log.ts";
import type { DataPaths } from "../paths.ts";
import type { AppInstall, PlatformAdapter } from "../platform/types.ts";

/**
 * A platform adapter for build tests: `pointCurrent` repoints `DATA/current` (symlink + atomic rename;
 * a junction on Windows), `locateApp` returns `app` when given, everything else throws.
 */
export function fakePlatform(opts: { app?: AppInstall; id?: Platform } = {}): PlatformAdapter {
	const id = opts.id ?? (process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : "darwin");
	const unsupported = (method: string) => async (): Promise<never> => {
		throw new Error(`fake platform: ${method} is not available in tests`);
	};
	return {
		id,
		locateApp: async () => {
			if (opts.app === undefined) throw new Error("Grok Bot not found");
			return opts.app;
		},
		findRunningApp: async () => undefined,
		quitApp: unsupported("quitApp"),
		launchApp: unsupported("launchApp"),
		hookInstall: unsupported("hookInstall"),
		hookRemove: unsupported("hookRemove"),
		hookStatus: unsupported("hookStatus"),
		autostartInstall: unsupported("autostartInstall"),
		autostartRemove: unsupported("autostartRemove"),
		startAgent: unsupported("startAgent"),
		stopAgent: unsupported("stopAgent"),
		async pointCurrent(paths: DataPaths, buildDir: string) {
			if (process.platform === "win32") {
				await unlink(paths.current).catch(() => undefined);
				await symlink(buildDir, paths.current, "junction");
				return;
			}
			const temp = `${paths.current}.tmp-${randomBytes(4).toString("hex")}`;
			await symlink(buildDir, temp, "dir");
			await rename(temp, paths.current);
		},
		notify: async () => {},
		openPath: unsupported("openPath"),
		binName: () => (id === "win32" ? "bgb.exe" : "bgb"),
	};
}

export interface TestContext {
	ctx: CoreContext;
	/** Temp parent of `DATA`; fixtures may live here too. */
	dir: string;
	cleanup(): Promise<void>;
}

/** A fresh temp `DATA` with a fake platform and a silent logger. */
export async function makeTestContext(opts: { app?: AppInstall; id?: Platform } = {}): Promise<TestContext> {
	const dir = await mkdtemp(path.join(tmpdir(), "bgb-s1-"));
	const ctx = await createContext({ dataDir: path.join(dir, "data"), platform: fakePlatform(opts), log: nullLogger });
	return { ctx, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

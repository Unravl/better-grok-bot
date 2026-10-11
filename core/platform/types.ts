import type { Platform } from "../../sdk/index.ts";
import type { DataPaths } from "../paths.ts";

export interface AppInstall {
	kind: "mac-bundle" | "win-nsis" | "linux-package" | "linux-appimage" | "custom";
	root: string;
	executable: string;
	asarPath: string;
	version: string;
}

export interface RunningApp {
	pid: number;
}

export type HookRecord =
	| { kind: "launchctl" | "user-env"; value: string }
	| { kind: "desktop-entry"; value: string; path: string; origin: "created" | "system-copy" | "user-file" };

export type HookStatus = { state: "active" } | { state: "absent" } | { state: "conflict"; value: string };

export class HookConflictError extends Error {
	constructor(readonly value: string) {
		super(`VITE_DEV_SERVER_URL is already set to ${value}`);
		this.name = "HookConflictError";
	}
}

export interface PlatformAdapter {
	readonly id: Platform;
	locateApp(explicit: string | null): Promise<AppInstall>;
	findRunningApp(app: AppInstall): Promise<RunningApp | undefined>;
	/** True once the process is gone. */
	quitApp(pid: number, opts: { force: boolean }): Promise<boolean>;
	launchApp(app: AppInstall, env: Record<string, string>, args: string[]): Promise<void>;
	/** Throws {@link HookConflictError} on a foreign value. */
	hookInstall(url: string, app: AppInstall, previous: HookRecord | null): Promise<HookRecord>;
	/** Touches the artifact only while it still matches the record. */
	hookRemove(record: HookRecord): Promise<"removed" | "not-owned">;
	hookStatus(url: string, app: AppInstall | undefined): Promise<HookStatus>;
	autostartInstall(binPath: string, paths: DataPaths): Promise<void>;
	autostartRemove(): Promise<void>;
	startAgent(binPath: string, paths: DataPaths): Promise<void>;
	stopAgent(paths: DataPaths): Promise<void>;
	pointCurrent(paths: DataPaths, buildDir: string): Promise<void>;
	/** Best effort, never throws. */
	notify(title: string, body: string): Promise<void>;
	openPath(path: string): Promise<void>;
	binName(): "bgb" | "bgb.exe";
}

/** A hook value is ours when it equals this install's renderer URL or is a grok-mods URL. */
export function isOwnHookValue(value: string, rendererUrl: string): boolean {
	return value === rendererUrl || value.endsWith("/GrokMods/current/renderer/index.html");
}

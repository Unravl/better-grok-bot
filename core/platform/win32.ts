import { readdir, stat, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { RENDERER_URL_ENV } from "../../sdk/index.ts";
import { readAppPackage } from "../app/package.ts";
import { errorMessage } from "../errors.ts";
import type { DataPaths } from "../paths.ts";
import { runPowerShell } from "../powershell.ts";
import { stopAgentProcess } from "./agent-control.ts";
import {
	type CommandRunner,
	type DetachedSpawner,
	hookStatusFromValue,
	runCommand,
	spawnDetached,
	waitForExit,
} from "./common.ts";
import { type AppInstall, HookConflictError, type PlatformAdapter, type RunningApp } from "./types.ts";

export const RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const RUN_VALUE_NAME = "BetterGrokBot";
export const EXECUTABLE_NAMES = ["Grok Bot.exe", "grok-bot.exe", "sand.exe"] as const;
/** WinRT toasts need a registered AUMID; PowerShell's is always present. */
const TOAST_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/** A PowerShell single-quoted string literal. */
export function psQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** The directory of an uninstall entry's `DisplayIcon` (`"C:\…\Grok Bot.exe",0` → `C:\…`). */
export function displayIconDir(displayIcon: string): string | null {
	const file = displayIcon
		.trim()
		.replace(/,\s*-?\d+$/, "")
		.trim()
		.replace(/^"(.*)"$/, "$1")
		.trim();
	return file === "" ? null : path.win32.dirname(file);
}

export interface UninstallEntry {
	DisplayName?: string | null;
	InstallLocation?: string | null;
	DisplayIcon?: string | null;
}

/** Install roots named by uninstall entries (`InstallLocation`, else the `DisplayIcon` directory), in order. */
export function rootsFromUninstallEntries(json: string): string[] {
	const parsed = json.trim() === "" ? [] : (JSON.parse(json) as UninstallEntry | UninstallEntry[]);
	const entries = Array.isArray(parsed) ? parsed : [parsed];
	const roots: string[] = [];
	for (const entry of entries) {
		const location = entry.InstallLocation?.trim().replace(/^"(.*)"$/, "$1");
		const root = location ? location : entry.DisplayIcon ? displayIconDir(entry.DisplayIcon) : null;
		if (root !== null && !roots.includes(root)) roots.push(root);
	}
	return roots;
}

interface Win32Process {
	ProcessId?: number;
	ExecutablePath?: string | null;
	CommandLine?: string | null;
}

/** The main process from `Win32_Process … | ConvertTo-Json`: same executable, no `--type=` argument. */
export function parseWin32Processes(json: string, executable: string): RunningApp | undefined {
	if (json.trim() === "") return undefined;
	const parsed = JSON.parse(json) as Win32Process | Win32Process[];
	const want = path.win32.normalize(executable).toLowerCase();
	for (const proc of Array.isArray(parsed) ? parsed : [parsed]) {
		if (typeof proc.ProcessId !== "number" || !proc.ExecutablePath) continue;
		if (path.win32.normalize(proc.ExecutablePath).toLowerCase() !== want) continue;
		if (proc.CommandLine?.includes("--type=")) continue;
		return { pid: proc.ProcessId };
	}
	return undefined;
}

/** The `Run` value: `"DATA\bin\bgbw.exe" --data-dir "DATA" login`. */
export function runValueCommand(binPath: string, paths: DataPaths): string {
	return `"${path.win32.join(path.win32.dirname(binPath), "bgbw.exe")}" --data-dir "${paths.root}" login`;
}

const UNINSTALL_SCRIPT = `$keys=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');
$found=@(foreach($k in $keys){Get-ItemProperty -Path $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Grok Bot*' } | Select-Object DisplayName,InstallLocation,DisplayIcon});
if($found.Count -gt 0){ConvertTo-Json -InputObject $found -Compress}`;

export interface Win32Deps {
	powershell?: (script: string) => Promise<string>;
	run?: CommandRunner;
	spawn?: DetachedSpawner;
	env?: Record<string, string | undefined>;
	home?: string;
	quitWaitMs?: number;
	killWaitMs?: number;
}

async function exists(file: string): Promise<boolean> {
	return (await stat(file).catch(() => null)) !== null;
}

export function createWin32Adapter(deps: Win32Deps = {}): PlatformAdapter {
	const powershell = deps.powershell ?? ((script: string) => runPowerShell(script));
	const run = deps.run ?? runCommand;
	const spawn = deps.spawn ?? spawnDetached;
	const env = deps.env ?? process.env;
	const home = deps.home ?? homedir();

	const getUserEnv = async (): Promise<string | null> => {
		const value = (await powershell(`[Environment]::GetEnvironmentVariable(${psQuote(RENDERER_URL_ENV)},'User')`)).trim();
		return value === "" ? null : value;
	};
	const setUserEnv = async (value: string | null): Promise<void> => {
		await powershell(
			`[Environment]::SetEnvironmentVariable(${psQuote(RENDERER_URL_ENV)},${value === null ? "$null" : psQuote(value)},'User')`,
		);
	};

	/** An install root holding `resources\app.asar` and one of the known executables. */
	const installAt = async (root: string, executable?: string): Promise<AppInstall | null> => {
		const asarPath = path.join(root, "resources", "app.asar");
		if (!(await exists(asarPath))) return null;
		let exe = executable;
		if (exe === undefined) {
			for (const name of EXECUTABLE_NAMES) {
				if (await exists(path.join(root, name))) {
					exe = path.join(root, name);
					break;
				}
			}
		}
		if (exe === undefined) return null;
		return { kind: "win-nsis", root, executable: exe, asarPath, version: (await readAppPackage(asarPath)).version };
	};

	return {
		id: "win32",

		async locateApp(explicit) {
			if (explicit !== null) {
				const resolved = path.resolve(explicit);
				const info = await stat(resolved).catch(() => null);
				if (info === null) throw new Error(`${explicit}: no such file or directory`);
				const app = info.isDirectory() ? await installAt(resolved) : await installAt(path.dirname(resolved), resolved);
				if (app === null) throw new Error(`${explicit} is not a Grok Bot install (no resources\\app.asar or Grok Bot.exe)`);
				return app;
			}
			let registryRoots: string[] = [];
			try {
				registryRoots = rootsFromUninstallEntries(await powershell(UNINSTALL_SCRIPT));
			} catch {
				// Fall through to the folder scan.
			}
			for (const root of registryRoots) {
				const app = await installAt(root).catch(() => null);
				if (app) return app;
			}
			const programs = path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs");
			const dirs = await readdir(programs).catch(() => [] as string[]);
			for (const dir of dirs.sort()) {
				const app = await installAt(path.join(programs, dir)).catch(() => null);
				if (app) return app;
			}
			throw new Error("Grok Bot not found in the uninstall registry or %LOCALAPPDATA%\\Programs");
		},

		async findRunningApp(app) {
			const name = path.win32.basename(app.executable).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
			const json = await powershell(
				`$p=@(Get-CimInstance Win32_Process -Filter ${psQuote(`Name='${name}'`)} | Select-Object ProcessId,ExecutablePath,CommandLine); if($p.Count -gt 0){ConvertTo-Json -InputObject $p -Compress}`,
			);
			return parseWin32Processes(json, app.executable);
		},

		async quitApp(pid, opts) {
			await run(["taskkill", "/PID", String(pid)]);
			if (await waitForExit(pid, deps.quitWaitMs ?? 10_000)) return true;
			if (!opts.force) return false;
			await run(["taskkill", "/F", "/T", "/PID", String(pid)]);
			return waitForExit(pid, deps.killWaitMs ?? 5_000);
		},

		async launchApp(app, appEnv, args) {
			spawn([app.executable, ...args], { env: { ...env, ...appEnv }, cwd: app.root });
		},

		async hookInstall(url) {
			const status = hookStatusFromValue(await getUserEnv(), url);
			if (status.state === "conflict") throw new HookConflictError(status.value);
			await setUserEnv(url);
			return { kind: "user-env", value: url };
		},

		async hookRemove(record) {
			if (record.kind !== "user-env" || (await getUserEnv()) !== record.value) return "not-owned";
			await setUserEnv(null);
			return "removed";
		},

		async hookStatus(url) {
			return hookStatusFromValue(await getUserEnv(), url);
		},

		async autostartInstall(binPath, paths) {
			await powershell(
				`Set-ItemProperty -Path ${psQuote(RUN_KEY)} -Name ${psQuote(RUN_VALUE_NAME)} -Value ${psQuote(runValueCommand(binPath, paths))}`,
			);
		},

		async autostartRemove() {
			await powershell(
				`Remove-ItemProperty -Path ${psQuote(RUN_KEY)} -Name ${psQuote(RUN_VALUE_NAME)} -ErrorAction SilentlyContinue`,
			);
		},

		async startAgent(binPath, paths) {
			const bgbw = path.join(path.dirname(binPath), "bgbw.exe");
			spawn([bgbw, "--data-dir", paths.root, "agent"], { env: { ...env, BGB_DATA_DIR: paths.root } });
		},

		async stopAgent(paths) {
			await stopAgentProcess(paths, {
				killHard: async (pid) => {
					await run(["taskkill", "/F", "/PID", String(pid)]);
				},
			});
		},

		async pointCurrent(paths, buildDir) {
			// unlink removes a directory junction without touching its target.
			await unlink(paths.current).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
			await symlink(buildDir, paths.current, "junction");
		},

		async notify(title, body) {
			const script = `$null=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];
$xml=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);
$texts=$xml.GetElementsByTagName('text');
$null=$texts.Item(0).AppendChild($xml.CreateTextNode(${psQuote(title)}));
$null=$texts.Item(1).AppendChild($xml.CreateTextNode(${psQuote(body)}));
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(TOAST_APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;
			try {
				await powershell(script);
			} catch {
				// Best effort.
			}
		},

		async openPath(target) {
			try {
				// explorer.exe exits 1 even on success, so its exit code says nothing.
				spawn(["explorer.exe", target], { env });
			} catch (error) {
				throw new Error(`cannot open ${target}: ${errorMessage(error)}`);
			}
		},

		binName: () => "bgb.exe",
	};
}

export const adapter: PlatformAdapter = createWin32Adapter();

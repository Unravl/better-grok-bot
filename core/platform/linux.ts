import { createHash } from "node:crypto";
import { access, constants, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { readAppPackage } from "../app/package.ts";
import { dataPaths, defaultDataDir } from "../paths.ts";
import { stopAgentProcess } from "./agent-control.ts";
import {
	type CommandRunner,
	type DetachedSpawner,
	failureText,
	pointCurrentSymlink,
	runCommand,
	spawnDetached,
	waitForExit,
} from "./common.ts";
import {
	MAIN_GROUP,
	autostartEntry,
	entryRendererUrl,
	getValue,
	grokBotEntry,
	hookEntry,
	hookedUrl,
	isHooked,
	parseDesktopFile,
	parseExec,
	unhookEntry,
	unwrapEnv,
} from "./desktop-entry.ts";
import { type AppInstall, HookConflictError, type HookStatus, type PlatformAdapter, type RunningApp, isOwnHookValue } from "./types.ts";

export const DESKTOP_FILE_NAME = "grok-bot.desktop";
export const AUTOSTART_FILE_NAME = "better-grok-bot.desktop";
export const EXECUTABLE_NAMES = ["grok-bot", "Grok Bot", "sand"] as const;

/** `/proc/<pid>/cmdline` (NUL-separated, NUL-terminated) → argv. */
export function parseCmdline(raw: string): string[] {
	const parts = raw.split("\0");
	if (parts[parts.length - 1] === "") parts.pop();
	return parts;
}

/** `/proc/<pid>/environ` → variables. */
export function parseEnviron(raw: string): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const entry of raw.split("\0")) {
		const eq = entry.indexOf("=");
		if (eq > 0) vars[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return vars;
}

export interface ProcInfo {
	argv: string[];
	/** Real path of `/proc/<pid>/exe`, or of an absolute argv[0]; `null` when unreadable. */
	exe: string | null;
	environ: Record<string, string>;
}

/**
 * True for Grok Bot's main process: no `--type=` argument, and either the AppImage it runs from
 * (`APPIMAGE`) or its binary is `realExecutable`.
 */
export function isMainProcess(info: ProcInfo, realExecutable: string, appImage: boolean): boolean {
	if (info.argv.length === 0 || info.argv.some((arg) => arg.startsWith("--type="))) return false;
	return appImage ? info.environ.APPIMAGE === realExecutable : info.exe === realExecutable;
}

export interface LinuxDeps {
	run?: CommandRunner;
	spawn?: DetachedSpawner;
	env?: Record<string, string | undefined>;
	home?: string;
	/** deb/rpm install root (default `/opt/Grok Bot`). */
	optRoot?: string;
	procRoot?: string;
	/** `DATA` for AppImage extracts (default: `BGB_DATA_DIR`, else the default data dir, read per call). */
	dataDir?: () => string;
	quitWaitMs?: number;
	killWaitMs?: number;
}

async function exists(file: string): Promise<boolean> {
	return (await stat(file).catch(() => null)) !== null;
}

async function readText(file: string): Promise<string | null> {
	return readFile(file, "utf8").catch(() => null);
}

/** An `.AppImage` file name, or the AppImage magic (`AI` + type 1/2 at offset 8 of the ELF header). */
export async function isAppImage(file: string): Promise<boolean> {
	if (/\.appimage$/i.test(file)) return true;
	const head = new Uint8Array(await Bun.file(file).slice(0, 11).arrayBuffer().catch(() => new ArrayBuffer(0)));
	return head[0] === 0x7f && head[8] === 0x41 && head[9] === 0x49 && (head[10] === 1 || head[10] === 2);
}

export function createLinuxAdapter(deps: LinuxDeps = {}): PlatformAdapter {
	const run = deps.run ?? runCommand;
	const spawn = deps.spawn ?? spawnDetached;
	const env = deps.env ?? process.env;
	const home = deps.home ?? homedir();
	const optRoot = deps.optRoot ?? "/opt/Grok Bot";
	const procRoot = deps.procRoot ?? "/proc";
	const dataDir = deps.dataDir ?? (() => env.BGB_DATA_DIR || defaultDataDir("linux", env, home));

	const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
	const userDesktopFile = path.join(dataHome, "applications", DESKTOP_FILE_NAME);
	const autostartFile = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "autostart", AUTOSTART_FILE_NAME);
	const systemDesktopFiles = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
		.split(":")
		.filter((dir) => dir !== "")
		.map((dir) => path.join(dir, "applications", DESKTOP_FILE_NAME));
	const desktopFiles = [userDesktopFile, ...systemDesktopFiles];

	/** Resolves a bare program name through `PATH`. */
	const which = async (program: string): Promise<string | null> => {
		if (program.includes("/")) return path.resolve(program);
		for (const dir of (env.PATH ?? "").split(":")) {
			if (dir === "") continue;
			const candidate = path.join(dir, program);
			if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
		}
		return null;
	};

	/** A package install root (`resources/app.asar` + an executable). */
	const packageAt = async (root: string, executable?: string): Promise<AppInstall | null> => {
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
		return { kind: "linux-package", root, executable: exe, asarPath, version: (await readAppPackage(asarPath)).version };
	};

	/**
	 * An AppImage, reached through `executable` (possibly a symlink, which stays the launch path). The asar
	 * comes from an extract cached per target (path, size, mtime), so a repointed symlink yields a new one.
	 */
	const appImageAt = async (executable: string): Promise<AppInstall> => {
		const real = await realpath(executable);
		const info = await stat(real);
		const key = createHash("sha256").update(`${real}\0${info.size}\0${info.mtimeMs}`).digest("hex").slice(0, 32);
		const dir = path.join(dataPaths(dataDir()).cache, "appimage", key);
		const asarPath = path.join(dir, "squashfs-root", "resources", "app.asar");
		if (!(await exists(asarPath))) {
			await rm(dir, { recursive: true, force: true });
			await mkdir(dir, { recursive: true });
			const partial = await run([real, "--appimage-extract", "resources/app.asar"], { cwd: dir });
			if (!(await exists(asarPath))) {
				const full = await run([real, "--appimage-extract"], { cwd: dir, timeoutMs: 300_000 });
				if (!(await exists(asarPath))) {
					await rm(dir, { recursive: true, force: true });
					throw new Error(`cannot extract resources/app.asar from ${real}: ${failureText(full.code !== 0 ? full : partial)}`);
				}
			}
		}
		return { kind: "linux-appimage", root: real, executable, asarPath, version: (await readAppPackage(asarPath)).version };
	};

	/** A program path: a package executable (its dir holds `resources/app.asar`) or an AppImage. */
	const appFromProgram = async (program: string): Promise<AppInstall | null> => {
		const real = await realpath(program).catch(() => null);
		if (real === null) return null;
		const info = await stat(real);
		if (info.isDirectory()) return packageAt(real);
		const pkg = await packageAt(path.dirname(real), program);
		if (pkg) return pkg;
		return (await isAppImage(real)) ? appImageAt(program) : null;
	};

	/** The program a desktop file's `[Desktop Entry]` `Exec` runs, unwrapping a BGB `env` hook. */
	const desktopProgram = async (file: string): Promise<string | null> => {
		const text = await readText(file);
		const exec = text === null ? undefined : getValue(parseDesktopFile(text), MAIN_GROUP, "Exec");
		const program = exec === undefined ? undefined : unwrapEnv(parseExec(exec))[0];
		return program === undefined ? null : which(program);
	};

	/** The desktop file in effect: the user override, else the first system entry. */
	const effectiveDesktopText = async (): Promise<string | null> => {
		for (const file of desktopFiles) {
			const text = await readText(file);
			if (text !== null) return text;
		}
		return null;
	};

	const readProc = async (pid: string): Promise<ProcInfo | null> => {
		const cmdline = await readText(path.join(procRoot, pid, "cmdline"));
		if (cmdline === null) return null;
		const argv = parseCmdline(cmdline);
		let exe = await readlink(path.join(procRoot, pid, "exe")).catch(() => null);
		if (exe === null && argv[0]?.startsWith("/")) exe = argv[0];
		return {
			argv,
			exe: exe === null ? null : await realpath(exe).catch(() => exe),
			environ: parseEnviron((await readText(path.join(procRoot, pid, "environ"))) ?? ""),
		};
	};

	const hookStatusOf = (text: string | null, url: string): HookStatus => {
		if (text === null) return { state: "absent" };
		const hooked = hookedUrl(text);
		if (hooked === url) return { state: "active" };
		const value = hooked ?? entryRendererUrl(text);
		if (value !== null && !isOwnHookValue(value, url)) return { state: "conflict", value };
		return { state: "absent" };
	};

	return {
		id: "linux",

		async locateApp(explicit) {
			if (explicit !== null) {
				const app = await appFromProgram(path.resolve(explicit));
				if (app === null) throw new Error(`${explicit} is not a Grok Bot install, executable or AppImage`);
				return app;
			}
			const opt = await packageAt(optRoot).catch(() => null);
			if (opt) {
				// Prefer the desktop entry's program (e.g. /usr/bin/grok-bot) when it runs this install.
				for (const file of desktopFiles) {
					const program = await desktopProgram(file);
					const real = program === null ? null : await realpath(program).catch(() => null);
					if (program !== null && real !== null && path.dirname(real) === (await realpath(optRoot))) {
						return { ...opt, executable: program };
					}
				}
				return opt;
			}
			for (const file of desktopFiles) {
				const program = await desktopProgram(file);
				const app = program === null ? null : await appFromProgram(program).catch(() => null);
				if (app) return app;
			}
			for (const link of [path.join(dataHome, "grok-bot", "appimage"), path.join(home, ".local", "bin", "grok-bot-appimage")]) {
				if (await exists(link)) return appImageAt(link);
			}
			throw new Error(`Grok Bot not found (no ${optRoot}, ${DESKTOP_FILE_NAME} entry or AppImage link)`);
		},

		async findRunningApp(app) {
			const appImage = app.kind === "linux-appimage";
			const realExecutable = await realpath(app.executable).catch(() => app.executable);
			const pids = (await readdir(procRoot).catch(() => [] as string[])).filter((name) => /^\d+$/.test(name));
			for (const pid of pids.sort((a, b) => Number(a) - Number(b))) {
				const info = await readProc(pid);
				if (info && isMainProcess(info, realExecutable, appImage)) return { pid: Number(pid) } satisfies RunningApp;
			}
			return undefined;
		},

		async quitApp(pid, opts) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				return true;
			}
			if (await waitForExit(pid, deps.quitWaitMs ?? 10_000)) return true;
			if (!opts.force) return false;
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				return true;
			}
			return waitForExit(pid, deps.killWaitMs ?? 5_000);
		},

		async launchApp(app, appEnv, args) {
			spawn([app.executable, ...args], { env: { ...env, ...appEnv } });
		},

		async hookInstall(url, app, previous) {
			const userFile = userDesktopFile;
			const existing = await readText(userFile);
			let text: string;
			let origin: "created" | "system-copy" | "user-file";
			if (existing !== null) {
				if (!isHooked(existing)) {
					const value = entryRendererUrl(existing);
					if (value !== null && !isOwnHookValue(value, url)) throw new HookConflictError(value);
					origin = "user-file";
				} else {
					origin = previous?.kind === "desktop-entry" ? previous.origin : "user-file";
				}
				text = existing;
			} else {
				let system: string | null = null;
				for (const file of systemDesktopFiles) {
					system = await readText(file);
					if (system !== null) break;
				}
				origin = system === null ? "created" : "system-copy";
				text = system ?? grokBotEntry(app.executable);
			}
			const dir = path.dirname(userFile);
			await mkdir(dir, { recursive: true });
			await writeFile(userFile, hookEntry(text, url));
			await run(["update-desktop-database", dir]);
			return { kind: "desktop-entry", value: url, path: userFile, origin };
		},

		async hookRemove(record) {
			if (record.kind !== "desktop-entry") return "not-owned";
			const text = await readText(record.path);
			if (text === null || !isHooked(text)) return "not-owned";
			if (record.origin === "user-file") await writeFile(record.path, unhookEntry(text));
			else await rm(record.path, { force: true });
			await run(["update-desktop-database", path.dirname(record.path)]);
			return "removed";
		},

		async hookStatus(url) {
			return hookStatusOf(await effectiveDesktopText(), url);
		},

		async autostartInstall(binPath, paths) {
			await mkdir(path.dirname(autostartFile), { recursive: true });
			await writeFile(autostartFile, autostartEntry(binPath, paths.root));
		},

		async autostartRemove() {
			await rm(autostartFile, { force: true });
		},

		async startAgent(binPath, paths) {
			spawn([binPath, "agent"], { env: { ...env, BGB_DATA_DIR: paths.root } });
		},

		async stopAgent(paths) {
			await stopAgentProcess(paths);
		},

		pointCurrent: pointCurrentSymlink,

		async notify(title, body) {
			try {
				await run(["notify-send", "--app-name=Better Grok Bot", title, body]);
			} catch {
				// Best effort; missing notify-send is fine.
			}
		},

		async openPath(target) {
			spawn(["xdg-open", target], { env });
		},

		binName: () => "bgb",
	};
}

export const adapter: PlatformAdapter = createLinuxAdapter();

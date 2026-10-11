import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import * as path from "node:path";
import { RENDERER_URL_ENV } from "../../sdk/index.ts";
import { readAppPackage } from "../app/package.ts";
import type { DataPaths } from "../paths.ts";
import { stopAgentProcess } from "./agent-control.ts";
import {
	type CommandRunner,
	type DetachedSpawner,
	failureText,
	hookStatusFromValue,
	pointCurrentSymlink,
	runCommand,
	spawnDetached,
	waitForExit,
} from "./common.ts";
import { type AppInstall, HookConflictError, type HookRecord, type PlatformAdapter } from "./types.ts";

export const APP_BUNDLE_ID = "com.anysphere.sand";
export const AGENT_LABEL = "io.github.unravl.bettergrokbot.agent";
export const LOGIN_LABEL = "io.github.unravl.bettergrokbot.login";
export const HELPER_LABEL = "io.github.unravl.bettergrokbot.helper";

/** `~/Library/LaunchAgents/<label>.plist`. */
export function launchAgentPath(home: string, label: string): string {
	return path.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

export type PlistValue = string | boolean | readonly string[] | { readonly [key: string]: string };

function xmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Serializes a flat launchd property list (strings, booleans, string arrays, string dictionaries). */
export function plistXml(dict: Readonly<Record<string, PlistValue>>): string {
	const body = Object.entries(dict).flatMap(([key, value]) => {
		const lines = [`\t<key>${xmlEscape(key)}</key>`];
		if (typeof value === "boolean") lines.push(value ? "\t<true/>" : "\t<false/>");
		else if (typeof value === "string") lines.push(`\t<string>${xmlEscape(value)}</string>`);
		else if (Array.isArray(value)) {
			lines.push("\t<array>", ...value.map((item: string) => `\t\t<string>${xmlEscape(item)}</string>`), "\t</array>");
		} else {
			lines.push("\t<dict>");
			for (const [k, v] of Object.entries(value)) {
				lines.push(`\t\t<key>${xmlEscape(k)}</key>`, `\t\t<string>${xmlEscape(v as string)}</string>`);
			}
			lines.push("\t</dict>");
		}
		return lines;
	});
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		...body,
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}

/** The agent job: `bgb agent`, kept alive by launchd. */
export function agentPlist(binPath: string, paths: DataPaths): string {
	const log = path.join(paths.logs, "agent.stdout.log");
	return plistXml({
		Label: AGENT_LABEL,
		ProgramArguments: [binPath, "agent"],
		EnvironmentVariables: { BGB_DATA_DIR: paths.root },
		RunAtLoad: true,
		KeepAlive: true,
		ProcessType: "Background",
		StandardOutPath: log,
		StandardErrorPath: log,
	});
}

/** The login job: `bgb login`, once per login session. */
export function loginPlist(binPath: string, paths: DataPaths): string {
	const log = path.join(paths.logs, "login.log");
	return plistXml({
		Label: LOGIN_LABEL,
		ProgramArguments: [binPath, "login"],
		EnvironmentVariables: { BGB_DATA_DIR: paths.root },
		RunAtLoad: true,
		StandardOutPath: log,
		StandardErrorPath: log,
	});
}

/** PID of the main process in a `ps -axww -o pid=,args=` listing; helper processes never match. */
export function parsePsMainPid(listing: string, executable: string): number | undefined {
	for (const line of listing.split("\n")) {
		const match = /^\s*(\d+) (.*)$/.exec(line);
		const args = match?.[2];
		if (args === undefined) continue;
		if ((args === executable || args.startsWith(`${executable} `)) && !args.includes(" --type=")) return Number(match?.[1]);
	}
	return undefined;
}

interface InfoPlist {
	CFBundleIdentifier?: string;
	CFBundleExecutable?: string;
}

export interface DarwinDeps {
	run?: CommandRunner;
	spawn?: DetachedSpawner;
	env?: Record<string, string | undefined>;
	home?: string;
	uid?: number;
	/** Wait after the AppleScript quit (default 15 s) and after `kill -9` (5 s). */
	quitWaitMs?: number;
	killWaitMs?: number;
}

async function isDirectory(candidate: string): Promise<boolean> {
	return (await stat(candidate).catch(() => null))?.isDirectory() ?? false;
}

export function createDarwinAdapter(deps: DarwinDeps = {}): PlatformAdapter {
	const run = deps.run ?? runCommand;
	const spawn = deps.spawn ?? spawnDetached;
	const env = deps.env ?? process.env;
	const home = deps.home ?? homedir();
	const domain = `gui/${deps.uid ?? userInfo().uid}`;
	const agentPlistPath = launchAgentPath(home, AGENT_LABEL);
	const loginPlistPath = launchAgentPath(home, LOGIN_LABEL);

	const launchctl = async (...args: string[]) => run(["launchctl", ...args]);

	const getenv = async (): Promise<string | null> => {
		const result = await launchctl("getenv", RENDERER_URL_ENV);
		const value = result.stdout.trim();
		return result.code === 0 && value !== "" ? value : null;
	};

	const readApp = async (appPath: string): Promise<AppInstall> => {
		const plistPath = path.join(appPath, "Contents", "Info.plist");
		const result = await run(["plutil", "-convert", "json", "-o", "-", plistPath]);
		if (result.code !== 0) throw new Error(`cannot read ${plistPath}: ${failureText(result)}`);
		const plist = JSON.parse(result.stdout) as InfoPlist;
		if (plist.CFBundleIdentifier !== APP_BUNDLE_ID) {
			throw new Error(`${appPath} has bundle id ${plist.CFBundleIdentifier ?? "(none)"}, expected ${APP_BUNDLE_ID}`);
		}
		if (plist.CFBundleExecutable === undefined) throw new Error(`${plistPath} lacks CFBundleExecutable`);
		const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
		return {
			kind: "mac-bundle",
			root: appPath,
			executable: path.join(appPath, "Contents", "MacOS", plist.CFBundleExecutable),
			asarPath,
			version: (await readAppPackage(asarPath)).version,
		};
	};

	return {
		id: "darwin",

		async locateApp(explicit) {
			if (explicit !== null) {
				const resolved = path.resolve(explicit);
				if (!(await isDirectory(resolved))) throw new Error(`${explicit}: no such app bundle`);
				return readApp(await realpath(resolved));
			}
			for (const candidate of [path.join("/Applications", "Grok Bot.app"), path.join(home, "Applications", "Grok Bot.app")]) {
				if (await isDirectory(candidate)) return readApp(await realpath(candidate));
			}
			const found = await run(["mdfind", `kMDItemCFBundleIdentifier == '${APP_BUNDLE_ID}'`]);
			const first = found.stdout.split("\n").find((line) => line.endsWith(".app"));
			if (first !== undefined) return readApp(await realpath(first));
			throw new Error("Grok Bot not found in /Applications, ~/Applications or Spotlight");
		},

		async findRunningApp(app) {
			const result = await run(["ps", "-axww", "-o", "pid=,args="]);
			if (result.code !== 0) throw new Error(`ps failed: ${failureText(result)}`);
			const pid = parsePsMainPid(result.stdout, app.executable);
			return pid === undefined ? undefined : { pid };
		},

		async quitApp(pid, opts) {
			await run(["osascript", "-e", `tell application id "${APP_BUNDLE_ID}" to quit`]);
			if (await waitForExit(pid, deps.quitWaitMs ?? 15_000)) return true;
			if (!opts.force) return false;
			await run(["kill", "-9", String(pid)]);
			return waitForExit(pid, deps.killWaitMs ?? 5_000);
		},

		async launchApp(app, appEnv, args) {
			const envArgs = Object.entries(appEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
			const passthrough = args.length > 0 ? ["--args", ...args] : [];
			const result = await run(["open", "-a", app.root, ...envArgs, ...passthrough]);
			if (result.code !== 0) throw new Error(`open failed: ${failureText(result)}`);
		},

		async hookInstall(url) {
			const status = hookStatusFromValue(await getenv(), url);
			if (status.state === "conflict") throw new HookConflictError(status.value);
			const result = await launchctl("setenv", RENDERER_URL_ENV, url);
			if (result.code !== 0) throw new Error(`launchctl setenv failed: ${failureText(result)}`);
			return { kind: "launchctl", value: url };
		},

		async hookRemove(record: HookRecord) {
			if (record.kind !== "launchctl" || (await getenv()) !== record.value) return "not-owned";
			const result = await launchctl("unsetenv", RENDERER_URL_ENV);
			if (result.code !== 0) throw new Error(`launchctl unsetenv failed: ${failureText(result)}`);
			return "removed";
		},

		async hookStatus(url) {
			return hookStatusFromValue(await getenv(), url);
		},

		async autostartInstall(binPath, paths) {
			await mkdir(path.dirname(agentPlistPath), { recursive: true });
			await mkdir(paths.logs, { recursive: true });
			await writeFile(agentPlistPath, agentPlist(binPath, paths));
			// launchd loads the login job at the next login; loading it now would run `bgb login` during setup.
			await writeFile(loginPlistPath, loginPlist(binPath, paths));
			await launchctl("bootout", `${domain}/${AGENT_LABEL}`);
			const result = await launchctl("bootstrap", domain, agentPlistPath);
			if (result.code !== 0) throw new Error(`launchctl bootstrap ${AGENT_LABEL} failed: ${failureText(result)}`);
		},

		async autostartRemove() {
			await launchctl("bootout", `${domain}/${AGENT_LABEL}`);
			await launchctl("bootout", `${domain}/${LOGIN_LABEL}`);
			await rm(agentPlistPath, { force: true });
			await rm(loginPlistPath, { force: true });
		},

		async startAgent(binPath, paths) {
			if (await Bun.file(agentPlistPath).exists()) {
				// Fails with "already loaded" when the job is loaded; kickstart starts it either way.
				await launchctl("bootstrap", domain, agentPlistPath);
				const result = await launchctl("kickstart", "-k", `${domain}/${AGENT_LABEL}`);
				if (result.code !== 0) throw new Error(`launchctl kickstart failed: ${failureText(result)}`);
				return;
			}
			spawn([binPath, "agent"], { env: { ...env, BGB_DATA_DIR: paths.root } });
		},

		async stopAgent(paths) {
			await stopAgentProcess(paths, {
				requestStop: async () => {
					// Without bootout, KeepAlive would restart the agent right away.
					if (!(await Bun.file(agentPlistPath).exists())) return false;
					await launchctl("bootout", `${domain}/${AGENT_LABEL}`);
					return true;
				},
			});
		},

		pointCurrent: pointCurrentSymlink,

		async notify(title, body) {
			try {
				await run([
					"osascript",
					"-e",
					"on run argv",
					"-e",
					"display notification (item 2 of argv) with title (item 1 of argv)",
					"-e",
					"end run",
					title,
					body,
				]);
			} catch {
				// Best effort.
			}
		},

		async openPath(target) {
			const result = await run(["open", target]);
			if (result.code !== 0) throw new Error(`open ${target} failed: ${failureText(result)}`);
		},

		binName: () => "bgb",
	};
}

export const adapter: PlatformAdapter = createDarwinAdapter();

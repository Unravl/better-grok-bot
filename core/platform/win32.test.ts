import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dataPaths, rendererUrl } from "../paths.ts";
import { makeFixtureAsar } from "../test/fixtures.ts";
import { type AppInstall, HookConflictError } from "./types.ts";
import {
	createWin32Adapter,
	displayIconDir,
	type JunctionOps,
	parseWin32Processes,
	pointCurrentJunction,
	psQuote,
	rootsFromUninstallEntries,
	runValueCommand,
} from "./win32.ts";

let tmp: string;
let scripts: string[];
let userEnv: string | null;
let uninstallJson: string;
let processJson: string;

/** A fake PowerShell: one user variable, canned registry and process listings. */
async function powershell(script: string): Promise<string> {
	scripts.push(script);
	if (script.startsWith("[Environment]::GetEnvironmentVariable")) return userEnv ?? "";
	const set = /^\[Environment\]::SetEnvironmentVariable\('VITE_DEV_SERVER_URL',(\$null|'((?:[^']|'')*)'),'User'\)$/.exec(script);
	if (set) {
		userEnv = set[1] === "$null" ? null : (set[2] ?? "").replaceAll("''", "'");
		return "";
	}
	if (script.includes("Uninstall")) return uninstallJson;
	if (script.includes("Win32_Process")) return processJson;
	return "";
}

beforeEach(async () => {
	tmp = await realpath(await mkdtemp(path.join(tmpdir(), "bgb-win32-")));
	scripts = [];
	userEnv = null;
	uninstallJson = "";
	processJson = "";
});
afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

const adapter = () =>
	createWin32Adapter({
		powershell,
		run: async () => ({ code: 0, stdout: "", stderr: "" }),
		spawn: () => {},
		env: { LOCALAPPDATA: path.join(tmp, "Local") },
		home: tmp,
	});

const URL = "file:///C:/Users/u/AppData/Local/BetterGrokBot/current/renderer/index.html?bgb";
const EXE = "C:\\Users\\u\\AppData\\Local\\Programs\\Grok Bot\\Grok Bot.exe";
const APP: AppInstall = { kind: "win-nsis", root: path.win32.dirname(EXE), executable: EXE, asarPath: "", version: "0.68.1" };

describe("pure parsing", () => {
	test("DisplayIcon", () => {
		expect(displayIconDir(`"${EXE}",0`)).toBe("C:\\Users\\u\\AppData\\Local\\Programs\\Grok Bot");
		expect(displayIconDir(`${EXE},0`)).toBe("C:\\Users\\u\\AppData\\Local\\Programs\\Grok Bot");
		expect(displayIconDir(`"${EXE}"`)).toBe("C:\\Users\\u\\AppData\\Local\\Programs\\Grok Bot");
		expect(displayIconDir(`${EXE}, -1`)).toBe("C:\\Users\\u\\AppData\\Local\\Programs\\Grok Bot");
		expect(displayIconDir("")).toBeNull();
	});

	test("uninstall entries: InstallLocation first, else DisplayIcon; single object or array", () => {
		const real = JSON.stringify({ DisplayName: "Grok Bot 0.68.1", InstallLocation: null, DisplayIcon: `"${EXE}",0` });
		expect(rootsFromUninstallEntries(real)).toEqual(["C:\\Users\\u\\AppData\\Local\\Programs\\Grok Bot"]);
		const many = JSON.stringify([
			{ DisplayName: "Grok Bot", InstallLocation: "D:\\Grok", DisplayIcon: `"${EXE}",0` },
			{ DisplayName: "Grok Bot", InstallLocation: "", DisplayIcon: `${EXE},0` },
			{ DisplayName: "Grok Bot" },
		]);
		expect(rootsFromUninstallEntries(many)).toEqual(["D:\\Grok", "C:\\Users\\u\\AppData\\Local\\Programs\\Grok Bot"]);
		expect(rootsFromUninstallEntries("")).toEqual([]);
	});

	test("Win32_Process JSON: main process only, path compared case-insensitively", () => {
		const list = JSON.stringify([
			{ ProcessId: 10, ExecutablePath: EXE, CommandLine: `"${EXE}" --type=renderer --field-trial-handle=1` },
			{ ProcessId: 20, ExecutablePath: EXE.toLowerCase(), CommandLine: `"${EXE}" --remote-debugging-port=9333` },
		]);
		expect(parseWin32Processes(list, EXE)).toEqual({ pid: 20 });
		const single = JSON.stringify({ ProcessId: 30, ExecutablePath: EXE, CommandLine: `"${EXE}"` });
		expect(parseWin32Processes(single, EXE)).toEqual({ pid: 30 });
		const other = JSON.stringify({ ProcessId: 40, ExecutablePath: "C:\\Other\\Grok Bot.exe", CommandLine: null });
		expect(parseWin32Processes(other, EXE)).toBeUndefined();
		expect(parseWin32Processes("", EXE)).toBeUndefined();
	});

	test("Run value and PowerShell quoting", () => {
		const data = dataPaths("C:\\Users\\u\\AppData\\Local\\BetterGrokBot");
		expect(runValueCommand("C:\\Users\\u\\AppData\\Local\\BetterGrokBot\\bin\\bgb.exe", data)).toBe(
			`"C:\\Users\\u\\AppData\\Local\\BetterGrokBot\\bin\\bgbw.exe" --data-dir "${data.root}" login`,
		);
		expect(psQuote("it's")).toBe("'it''s'");
	});
});

describe("hook (user environment)", () => {
	test("install, status, remove", async () => {
		const win = adapter();
		expect(await win.hookStatus(URL, APP)).toEqual({ state: "absent" });
		const record = await win.hookInstall(URL, APP, null);
		expect(record).toEqual({ kind: "user-env", value: URL });
		expect(userEnv).toBe(URL);
		expect(await win.hookStatus(URL, APP)).toEqual({ state: "active" });
		expect(await win.hookRemove(record)).toBe("removed");
		expect(userEnv).toBeNull();
	});

	test("foreign value → conflict, untouched", async () => {
		userEnv = "http://localhost:5173/it's";
		const win = adapter();
		expect(await win.hookStatus(URL, APP)).toEqual({ state: "conflict", value: "http://localhost:5173/it's" });
		await expect(win.hookInstall(URL, APP, null)).rejects.toBeInstanceOf(HookConflictError);
		expect(await win.hookRemove({ kind: "user-env", value: URL })).toBe("not-owned");
		expect(userEnv).toBe("http://localhost:5173/it's");
	});
});

describe("locateApp", () => {
	async function install(root: string): Promise<void> {
		const asarPath = path.join(root, "resources", "app.asar");
		await makeFixtureAsar(path.dirname(asarPath), { version: "0.68.1", renderer: { "index.html": "" }, asarPath });
		await writeFile(path.join(root, "Grok Bot.exe"), "");
	}

	test("from the uninstall entry's DisplayIcon", async () => {
		const root = path.join(tmp, "Custom", "Grok Bot");
		await install(root);
		uninstallJson = JSON.stringify({ DisplayName: "Grok Bot 0.68.1", DisplayIcon: `"${path.join(root, "Grok Bot.exe")}",0` });
		expect(await adapter().locateApp(null)).toEqual({
			kind: "win-nsis",
			root,
			executable: path.join(root, "Grok Bot.exe"),
			asarPath: path.join(root, "resources", "app.asar"),
			version: "0.68.1",
		});
	});

	test("falls back to scanning %LOCALAPPDATA%\\Programs", async () => {
		const root = path.join(tmp, "Local", "Programs", "Grok Bot");
		await install(root);
		await mkdir(path.join(tmp, "Local", "Programs", "Other App"), { recursive: true });
		expect(await adapter().locateApp(null)).toMatchObject({ root, version: "0.68.1" });
	});

	test("explicit exe or directory", async () => {
		const root = path.join(tmp, "x");
		await install(root);
		expect(await adapter().locateApp(path.join(root, "Grok Bot.exe"))).toMatchObject({ root, executable: path.join(root, "Grok Bot.exe") });
		expect(await adapter().locateApp(root)).toMatchObject({ root });
		await expect(adapter().locateApp(path.join(tmp, "nope"))).rejects.toThrow("no such file");
	});

	test("nothing installed → error", async () => {
		await expect(adapter().locateApp(null)).rejects.toThrow("Grok Bot not found");
	});
});

test("findRunningApp queries Win32_Process by executable name", async () => {
	processJson = JSON.stringify([{ ProcessId: 7, ExecutablePath: EXE, CommandLine: `"${EXE}"` }]);
	expect(await adapter().findRunningApp(APP)).toEqual({ pid: 7 });
	expect(scripts.at(-1)).toContain("-Filter 'Name=''Grok Bot.exe'''");
});

test("autostart Run value", async () => {
	const win = adapter();
	const paths = dataPaths(path.join(tmp, "BetterGrokBot"));
	await win.autostartInstall(path.join(paths.bin, "bgb.exe"), paths);
	expect(scripts.at(-1)).toContain("-Name 'BetterGrokBot'");
	expect(scripts.at(-1)).toContain("New-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Force");
	expect(scripts.at(-1)).toContain(`--data-dir "${paths.root}" login`);
	await win.autostartRemove();
	expect(scripts.at(-1)).toContain("Remove-ItemProperty");
});

test("notify never throws", async () => {
	const win = createWin32Adapter({
		powershell: async () => {
			throw new Error("no WinRT");
		},
	});
	await expect(win.notify("t", "b")).resolves.toBeUndefined();
});

test.skipIf(process.platform !== "win32")("pointCurrent repoints the junction and keeps the old build", async () => {
	const win = adapter();
	const paths = dataPaths(path.join(tmp, "BetterGrokBot"));
	const a = path.join(paths.builds, "a");
	const b = path.join(paths.builds, "b");
	for (const dir of [a, b]) {
		await mkdir(path.join(dir, "renderer"), { recursive: true });
		await writeFile(path.join(dir, "renderer", "index.html"), path.basename(dir));
	}
	await win.pointCurrent(paths, a);
	expect(await readFile(path.join(paths.current, "renderer", "index.html"), "utf8")).toBe("a");
	await win.pointCurrent(paths, b);
	expect(await readFile(path.join(paths.current, "renderer", "index.html"), "utf8")).toBe("b");
	expect(path.resolve(await readlink(paths.current))).toBe(path.resolve(b));
	expect(await readFile(path.join(a, "renderer", "index.html"), "utf8")).toBe("a");
	expect(rendererUrl(paths)).toContain("/current/renderer/index.html?bgb");
});

/** Junctions as a map; like Windows, rename refuses an existing destination. */
function fakeJunctions(initial: Record<string, string>, failRenameTo?: string): JunctionOps & { links: Map<string, string> } {
	const links = new Map(Object.entries(initial));
	const enoent = (p: string) => Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
	return {
		links,
		async symlink(target, link) {
			if (links.has(link)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
			links.set(link, target);
		},
		async rename(from, to) {
			const target = links.get(from);
			if (target === undefined) throw enoent(from);
			if (to === failRenameTo && from !== `${to}.old`) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			if (links.has(to)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			links.delete(from);
			links.set(to, target);
		},
		async unlink(link) {
			if (!links.delete(link)) throw enoent(link);
		},
		async isDirectory(link) {
			if (!links.has(link)) throw enoent(link);
			return true;
		},
	};
}

describe("pointCurrentJunction", () => {
	test("swaps the junction and clears leftovers of a crashed attempt", async () => {
		const ops = fakeJunctions({ C: "old", "C.new": "stale", "C.old": "older" });
		await pointCurrentJunction("C", "new", ops);
		expect([...ops.links]).toEqual([["C", "new"]]);
	});

	test("a failed final rename restores the old junction", async () => {
		const ops = fakeJunctions({ C: "old" }, "C");
		await expect(pointCurrentJunction("C", "new", ops)).rejects.toThrow("EPERM");
		expect([...ops.links]).toEqual([["C", "old"]]);
	});

	test("a failed junction creation leaves the old one in place", async () => {
		const ops = fakeJunctions({ C: "old" });
		ops.symlink = async () => {
			throw new Error("denied");
		};
		await expect(pointCurrentJunction("C", "new", ops)).rejects.toThrow("denied");
		expect(ops.links.get("C")).toBe("old");
	});
});

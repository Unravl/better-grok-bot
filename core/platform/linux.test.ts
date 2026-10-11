import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dataPaths, rendererUrl } from "../paths.ts";
import { makeFixtureAsar } from "../test/fixtures.ts";
import { type CommandRunner, runCommand } from "./common.ts";
import { MARKER_EXEC, hookEntry } from "./desktop-entry.ts";
import { createLinuxAdapter, isMainProcess, parseCmdline, parseEnviron } from "./linux.ts";
import { type AppInstall, HookConflictError } from "./types.ts";

let tmp: string;
let calls: string[][];
/** Records every command; only the fake AppImages (shell scripts in the temp dir) really run. */
const run: CommandRunner = async (argv, opts) => {
	calls.push(argv);
	if (argv[1] === "--appimage-extract") return runCommand(argv, opts);
	return { code: 0, stdout: "", stderr: "" };
};

beforeEach(async () => {
	tmp = await realpath(await mkdtemp(path.join(tmpdir(), "bgb-linux-")));
	calls = [];
});
afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string> {
	return {
		XDG_DATA_HOME: path.join(tmp, "data"),
		XDG_CONFIG_HOME: path.join(tmp, "config"),
		XDG_DATA_DIRS: path.join(tmp, "sys"),
		PATH: path.join(tmp, "path-bin"),
		...extra,
	};
}

function adapter(extra: Record<string, string> = {}) {
	return createLinuxAdapter({
		run,
		env: env(extra),
		home: path.join(tmp, "home"),
		optRoot: path.join(tmp, "opt", "Grok Bot"),
		procRoot: path.join(tmp, "proc"),
		dataDir: () => path.join(tmp, "bgb-data"),
		spawn: () => {},
	});
}

const URL = rendererUrl(dataPaths("/home/u/.local/share/BetterGrokBot"));
const APP: AppInstall = { kind: "linux-package", root: "/opt/Grok Bot", executable: "/opt/Grok Bot/grok-bot", asarPath: "", version: "0.68.1" };
const userFile = () => path.join(tmp, "data", "applications", "grok-bot.desktop");
const systemFile = () => path.join(tmp, "sys", "applications", "grok-bot.desktop");

describe("hook", () => {
	test("created: no entry anywhere → fresh hooked entry, removed on hookRemove", async () => {
		const linux = adapter();
		expect(await linux.hookStatus(URL, APP)).toEqual({ state: "absent" });
		const record = await linux.hookInstall(URL, APP, null);
		expect(record).toEqual({ kind: "desktop-entry", value: URL, path: userFile(), origin: "created" });
		const text = await readFile(userFile(), "utf8");
		expect(text).toContain('Exec=env "VITE_DEV_SERVER_URL=');
		expect(text).toContain(`${MARKER_EXEC}="/opt/Grok Bot/grok-bot" %U`);
		expect(calls).toContainEqual(["update-desktop-database", path.dirname(userFile())]);
		expect(await linux.hookStatus(URL, APP)).toEqual({ state: "active" });
		expect(await linux.hookRemove(record)).toBe("removed");
		expect(await Bun.file(userFile()).exists()).toBe(false);
		expect(await linux.hookStatus(URL, APP)).toEqual({ state: "absent" });
	});

	test("system-copy: the system entry is copied hooked into the user dir and deleted on removal", async () => {
		const system = "[Desktop Entry]\nName=Grok Bot\nExec=grok-bot %U\nIcon=grok-bot\n";
		await mkdir(path.dirname(systemFile()), { recursive: true });
		await writeFile(systemFile(), system);
		const linux = adapter();
		const record = await linux.hookInstall(URL, APP, null);
		expect(record).toMatchObject({ origin: "system-copy", path: userFile() });
		expect(await readFile(userFile(), "utf8")).toBe(hookEntry(system, URL));
		expect(await readFile(systemFile(), "utf8")).toBe(system);
		expect(await linux.hookRemove(record)).toBe("removed");
		expect(await Bun.file(userFile()).exists()).toBe(false);
	});

	test("user-file: hooked in place, re-hook keeps the origin, removal restores the original text", async () => {
		const original = "[Desktop Entry]\nName=Grok Bot\nExec=/home/u/.local/share/grok-bot/appimage %U\nX-AppImage-Version=1\n";
		await mkdir(path.dirname(userFile()), { recursive: true });
		await writeFile(userFile(), original);
		const linux = adapter();
		const first = await linux.hookInstall(URL, APP, null);
		expect(first).toMatchObject({ origin: "user-file" });
		const other = "file:///other/current/renderer/index.html?bgb";
		const second = await linux.hookInstall(other, APP, first);
		expect(second).toMatchObject({ origin: "user-file", value: other });
		expect(await readFile(userFile(), "utf8")).toBe(hookEntry(original, other));
		expect(await linux.hookRemove(second)).toBe("removed");
		expect(await readFile(userFile(), "utf8")).toBe(original);
	});

	test("re-hooking a created entry keeps origin created", async () => {
		const linux = adapter();
		const first = await linux.hookInstall(URL, APP, null);
		const second = await linux.hookInstall(URL, APP, first);
		expect(second.kind === "desktop-entry" && second.origin).toBe("created");
	});

	test("conflict: a foreign VITE_DEV_SERVER_URL in the user entry is never overwritten", async () => {
		const foreign = "[Desktop Entry]\nExec=env VITE_DEV_SERVER_URL=http://localhost:5173 grok-bot %U\n";
		await mkdir(path.dirname(userFile()), { recursive: true });
		await writeFile(userFile(), foreign);
		const linux = adapter();
		expect(await linux.hookStatus(URL, APP)).toEqual({ state: "conflict", value: "http://localhost:5173" });
		await expect(linux.hookInstall(URL, APP, null)).rejects.toBeInstanceOf(HookConflictError);
		expect(await readFile(userFile(), "utf8")).toBe(foreign);
	});

	test("a grok-mods URL is ours to replace", async () => {
		const grokMods = "file:///home/u/Library/Application%20Support/GrokMods/current/renderer/index.html";
		await mkdir(path.dirname(userFile()), { recursive: true });
		await writeFile(userFile(), `[Desktop Entry]\nExec=env VITE_DEV_SERVER_URL=${grokMods} grok-bot %U\n`);
		const linux = adapter();
		expect(await linux.hookStatus(URL, APP)).toEqual({ state: "absent" });
		expect(await linux.hookInstall(URL, APP, null)).toMatchObject({ origin: "user-file" });
		expect(await linux.hookStatus(URL, APP)).toEqual({ state: "active" });
	});

	test("hookRemove leaves a file whose marker is gone", async () => {
		const linux = adapter();
		const record = await linux.hookInstall(URL, APP, null);
		await writeFile(userFile(), "[Desktop Entry]\nExec=grok-bot\n");
		expect(await linux.hookRemove(record)).toBe("not-owned");
		expect(await readFile(userFile(), "utf8")).toBe("[Desktop Entry]\nExec=grok-bot\n");
	});
});

describe("locateApp", () => {
	async function fakeAppImage(name: string, version: string): Promise<string> {
		const asar = await makeFixtureAsar(path.join(tmp, "asars"), { version, renderer: { "index.html": "" } });
		const file = path.join(tmp, "apps", name);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(
			file,
			`#!/bin/sh\n[ "$1" = "--appimage-extract" ] || exit 2\necho "$2" >> '${file}.runs'\nmkdir -p squashfs-root/resources && cp '${asar}' squashfs-root/resources/app.asar\n`,
		);
		await chmod(file, 0o755);
		return file;
	}

	test("follows a repointed AppImage symlink while keeping the symlink as executable", async () => {
		const a = await fakeAppImage("Grok_Bot_0.68.1.AppImage", "0.68.1");
		const b = await fakeAppImage("Grok_Bot_0.69.0.AppImage", "0.69.0");
		const link = path.join(tmp, "data", "grok-bot", "appimage");
		await mkdir(path.dirname(link), { recursive: true });
		await symlink(a, link);
		const linux = adapter();
		const first = await linux.locateApp(null);
		expect(first).toMatchObject({ kind: "linux-appimage", executable: link, version: "0.68.1", root: a });
		expect(first.asarPath.startsWith(path.join(tmp, "bgb-data", "cache", "appimage"))).toBe(true);
		await rm(link);
		await symlink(b, link);
		const second = await linux.locateApp(null);
		expect(second).toMatchObject({ kind: "linux-appimage", executable: link, version: "0.69.0", root: b });
		expect(second.asarPath).not.toBe(first.asarPath);
		// Cached extract: locating the same target again does not rerun the AppImage.
		expect(await readFile(`${b}.runs`, "utf8")).toBe("resources/app.asar\n");
		expect((await linux.locateApp(null)).asarPath).toBe(second.asarPath);
		expect(await readFile(`${b}.runs`, "utf8")).toBe("resources/app.asar\n");
	});

	test("deb: /opt install with a bare desktop Exec resolved through PATH", async () => {
		const root = path.join(tmp, "opt", "Grok Bot");
		await makeFixtureAsar(path.join(root, "resources"), {
			version: "0.68.1",
			renderer: { "index.html": "" },
			asarPath: path.join(root, "resources", "app.asar"),
		});
		await writeFile(path.join(root, "grok-bot"), "#!/bin/sh\n");
		await chmod(path.join(root, "grok-bot"), 0o755);
		await mkdir(path.join(tmp, "path-bin"), { recursive: true });
		await symlink(path.join(root, "grok-bot"), path.join(tmp, "path-bin", "grok-bot"));
		await mkdir(path.dirname(systemFile()), { recursive: true });
		await writeFile(systemFile(), "[Desktop Entry]\nExec=grok-bot %U\n");
		const app = await adapter().locateApp(null);
		expect(app).toEqual({
			kind: "linux-package",
			root,
			executable: path.join(tmp, "path-bin", "grok-bot"),
			asarPath: path.join(root, "resources", "app.asar"),
			version: "0.68.1",
		});
	});

	test("a BGB-hooked desktop entry resolves to the real program", async () => {
		const root = path.join(tmp, "custom", "grok");
		await makeFixtureAsar(path.join(root, "resources"), {
			version: "0.70.0",
			renderer: { "index.html": "" },
			asarPath: path.join(root, "resources", "app.asar"),
		});
		await writeFile(path.join(root, "grok-bot"), "#!/bin/sh\n");
		await chmod(path.join(root, "grok-bot"), 0o755);
		await mkdir(path.dirname(userFile()), { recursive: true });
		await writeFile(userFile(), hookEntry(`[Desktop Entry]\nExec=${path.join(root, "grok-bot")} %U\n`, URL));
		expect(await adapter().locateApp(null)).toMatchObject({ kind: "linux-package", root, version: "0.70.0" });
	});

	test("nothing installed → error", async () => {
		await expect(adapter().locateApp(null)).rejects.toThrow("Grok Bot not found");
	});
});

describe("/proc parsing", () => {
	test("cmdline and environ", () => {
		expect(parseCmdline("/opt/Grok Bot/grok-bot\0--type=renderer\0")).toEqual(["/opt/Grok Bot/grok-bot", "--type=renderer"]);
		expect(parseCmdline("")).toEqual([]);
		expect(parseEnviron("A=1\0APPIMAGE=/x/Grok.AppImage\0B=a=b\0")).toEqual({ A: "1", APPIMAGE: "/x/Grok.AppImage", B: "a=b" });
	});

	test("isMainProcess", () => {
		const exe = "/opt/Grok Bot/grok-bot";
		expect(isMainProcess({ argv: ["grok-bot"], exe, environ: {} }, exe, false)).toBe(true);
		expect(isMainProcess({ argv: ["grok-bot", "--type=gpu-process"], exe, environ: {} }, exe, false)).toBe(false);
		expect(isMainProcess({ argv: ["other"], exe: "/usr/bin/other", environ: {} }, exe, false)).toBe(false);
		const image = "/home/u/Grok.AppImage";
		const mounted = { argv: ["/tmp/.mount_x/grok-bot"], exe: "/tmp/.mount_x/grok-bot", environ: { APPIMAGE: image } };
		expect(isMainProcess(mounted, image, true)).toBe(true);
		expect(isMainProcess({ ...mounted, environ: {} }, image, true)).toBe(false);
	});

	test("findRunningApp scans a /proc tree", async () => {
		const exe = path.join(tmp, "opt", "grok-bot");
		await mkdir(path.dirname(exe), { recursive: true });
		await writeFile(exe, "");
		const proc = async (pid: number, argv: string[], target: string) => {
			const dir = path.join(tmp, "proc", String(pid));
			await mkdir(dir, { recursive: true });
			await writeFile(path.join(dir, "cmdline"), `${argv.join("\0")}\0`);
			await writeFile(path.join(dir, "environ"), "");
			await symlink(target, path.join(dir, "exe"));
		};
		await proc(100, ["grok-bot", "--type=renderer"], exe);
		await proc(250, ["grok-bot", "--enable-features=x"], exe);
		await proc(300, ["bash"], "/bin/sh");
		await mkdir(path.join(tmp, "proc", "self"), { recursive: true });
		const app: AppInstall = { ...APP, executable: exe };
		expect(await adapter().findRunningApp(app)).toEqual({ pid: 250 });
	});
});

test("autostart file", async () => {
	const linux = adapter();
	const paths = dataPaths(path.join(tmp, "bgb data"));
	await linux.autostartInstall(path.join(paths.bin, "bgb"), paths);
	const file = path.join(tmp, "config", "autostart", "better-grok-bot.desktop");
	expect(await readFile(file, "utf8")).toContain(`Exec="${path.join(paths.bin, "bgb")}" --data-dir "${paths.root}" login\n`);
	await linux.autostartRemove();
	expect(await Bun.file(file).exists()).toBe(false);
});

test("notify never throws", async () => {
	const linux = createLinuxAdapter({
		run: async () => {
			throw new Error("boom");
		},
	});
	await expect(linux.notify("t", "b")).resolves.toBeUndefined();
});

import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dataPaths, defaultDataDir, ensureDataDir, rendererUrl } from "./paths.ts";

test("dataPaths lays out DATA", () => {
	const root = process.platform === "win32" ? "C:\\tmp\\data" : "/tmp/data";
	const paths = dataPaths(root);
	expect(paths.agentRecord).toBe(path.join(root, "agent.pid"));
	expect(paths.devPlugins).toBe(path.join(root, "dev-plugins.json"));
	expect(paths.binPrevious).toBe(path.join(root, "bin", "previous"));
	expect(paths.current).toBe(path.join(root, "current"));
});

test("rendererUrl encodes spaces and ends with ?bgb", () => {
	if (process.platform === "win32") {
		const url = rendererUrl(dataPaths("C:\\Users\\x\\AppData\\Local\\Better Grok Bot"));
		expect(url).toBe("file:///C:/Users/x/AppData/Local/Better%20Grok%20Bot/current/renderer/index.html?bgb");
		return;
	}
	const url = rendererUrl(dataPaths("/Users/x/Library/Application Support/BetterGrokBot"));
	expect(url).toBe("file:///Users/x/Library/Application%20Support/BetterGrokBot/current/renderer/index.html?bgb");
});

test("defaultDataDir per OS", () => {
	expect(defaultDataDir("darwin", {}, "/Users/x")).toBe("/Users/x/Library/Application Support/BetterGrokBot");
	expect(defaultDataDir("linux", {}, "/home/x")).toBe("/home/x/.local/share/BetterGrokBot");
	expect(defaultDataDir("linux", { XDG_DATA_HOME: "/xdg" }, "/home/x")).toBe("/xdg/BetterGrokBot");
	expect(defaultDataDir("win32", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "C:\\Users\\x")).toBe(
		"C:\\Users\\x\\AppData\\Local\\BetterGrokBot",
	);
});

test.skipIf(process.platform === "win32")("ensureDataDir makes DATA private", async () => {
	const parent = await mkdtemp(path.join(tmpdir(), "bgb-paths-"));
	try {
		const paths = dataPaths(path.join(parent, "data"));
		await ensureDataDir(paths);
		expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
		expect((await stat(paths.locks)).isDirectory()).toBe(true);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

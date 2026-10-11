import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dataPaths, defaultDataDir, ensureDataDir, rendererUrl } from "./paths.ts";

test("dataPaths lays out DATA", () => {
	const paths = dataPaths("/tmp/data");
	expect(paths.agentRecord).toBe(path.join("/tmp/data", "agent.pid"));
	expect(paths.devPlugins).toBe(path.join("/tmp/data", "dev-plugins.json"));
	expect(paths.binPrevious).toBe(path.join("/tmp/data", "bin", "previous"));
	expect(paths.current).toBe(path.join("/tmp/data", "current"));
});

test("rendererUrl encodes spaces and ends with ?bgb", () => {
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

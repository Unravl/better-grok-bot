import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dataPaths, rendererUrl } from "../paths.ts";
import { hookStatusFromValue, pointCurrentSymlink } from "./common.ts";
import { isOwnHookValue } from "./types.ts";

let tmp: string;
beforeEach(async () => {
	tmp = await realpath(await mkdtemp(path.join(tmpdir(), "bgb-common-")));
});
afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

test("isOwnHookValue: this install's URL or a grok-mods URL", () => {
	const url = rendererUrl(dataPaths("/Users/u/Library/Application Support/BetterGrokBot"));
	expect(isOwnHookValue(url, url)).toBe(true);
	expect(isOwnHookValue("file:///Users/u/Library/Application%20Support/GrokMods/current/renderer/index.html", url)).toBe(true);
	expect(isOwnHookValue(rendererUrl(dataPaths("/tmp/other-data")), url)).toBe(false);
	expect(isOwnHookValue("http://localhost:5173", url)).toBe(false);
});

test("hookStatusFromValue", () => {
	const url = "file:///d/current/renderer/index.html?bgb";
	expect(hookStatusFromValue(null, url)).toEqual({ state: "absent" });
	expect(hookStatusFromValue("", url)).toEqual({ state: "absent" });
	expect(hookStatusFromValue(url, url)).toEqual({ state: "active" });
	expect(hookStatusFromValue("file:///x/GrokMods/current/renderer/index.html", url)).toEqual({ state: "absent" });
	expect(hookStatusFromValue("http://vite", url)).toEqual({ state: "conflict", value: "http://vite" });
});

test.skipIf(process.platform === "win32")("pointCurrentSymlink repoints atomically and keeps old builds", async () => {
	const paths = dataPaths(tmp);
	const a = path.join(paths.builds, "a");
	const b = path.join(paths.builds, "b");
	for (const dir of [a, b]) {
		await mkdir(path.join(dir, "renderer"), { recursive: true });
		await writeFile(path.join(dir, "renderer", "index.html"), path.basename(dir));
	}
	await pointCurrentSymlink(paths, a);
	expect(await readlink(paths.current)).toBe(a);
	await pointCurrentSymlink(paths, b);
	expect(await readlink(paths.current)).toBe(b);
	expect(await readFile(path.join(paths.current, "renderer", "index.html"), "utf8")).toBe("b");
	expect(await readFile(path.join(a, "renderer", "index.html"), "utf8")).toBe("a");
	expect((await readdir(tmp)).filter((name) => name.startsWith(".current-"))).toEqual([]);
});

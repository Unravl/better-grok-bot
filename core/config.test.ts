import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ensureConfig, mutateConfig, parseConfig, readConfig } from "./config.ts";
import { type DataPaths, dataPaths, ensureDataDir } from "./paths.ts";

let paths: DataPaths;

beforeEach(async () => {
	paths = dataPaths(await mkdtemp(path.join(tmpdir(), "bgb-config-")));
	await ensureDataDir(paths);
});

afterEach(async () => {
	await rm(paths.root, { recursive: true, force: true });
});

test("ensureConfig creates defaults with a fresh token once", async () => {
	const created = await ensureConfig(paths);
	expect(created.bridgePort).toBe(39320);
	expect(created.bridgeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(created.autoUpdate).toBe(true);
	expect(created.appPath).toBeNull();
	expect((await ensureConfig(paths)).bridgeToken).toBe(created.bridgeToken);
	if (process.platform !== "win32") expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
});

test("readConfig fails when config.json is missing", async () => {
	await expect(readConfig(paths)).rejects.toThrow("does not exist");
});

test("an invalid field is rejected by name, never replaced", async () => {
	const config = await ensureConfig(paths);
	const bad = JSON.stringify({ ...config, bridgePort: 70000 });
	await writeFile(paths.config, bad);
	await expect(readConfig(paths)).rejects.toThrow("bridgePort must be an integer from 1 to 65535");
	await expect(ensureConfig(paths)).rejects.toThrow("bridgePort");
	await expect(mutateConfig(paths, () => {})).rejects.toThrow("bridgePort");
	expect(await readFile(paths.config, "utf8")).toBe(bad);
});

test("parseConfig checks every field", () => {
	const base = { bridgeToken: "t" };
	expect(parseConfig(base).bridgePort).toBe(39320);
	expect(() => parseConfig({})).toThrow("bridgeToken is missing");
	expect(() => parseConfig({ ...base, configVersion: 2 })).toThrow("configVersion");
	expect(() => parseConfig({ ...base, disabledPlugins: [1] })).toThrow("disabledPlugins");
	expect(() => parseConfig({ ...base, enabledThemes: "x" })).toThrow("enabledThemes");
	expect(() => parseConfig({ ...base, grants: { a: ["root"] } })).toThrow("grants");
	expect(() => parseConfig({ ...base, bridgePort: 1.5 })).toThrow("bridgePort");
	expect(() => parseConfig({ ...base, bridgeToken: "" })).toThrow("bridgeToken");
	expect(() => parseConfig({ ...base, autoUpdate: "yes" })).toThrow("autoUpdate");
	expect(() => parseConfig({ ...base, openAtLogin: 1 })).toThrow("openAtLogin");
	expect(() => parseConfig({ ...base, appPath: 3 })).toThrow("appPath");
	expect(parseConfig({ ...base, grants: { a: ["keys", "media"] } }).grants).toEqual({ a: ["keys", "media"] });
});

test("mutateConfig applies in-place edits and validates the result", async () => {
	const before = await ensureConfig(paths);
	const after = await mutateConfig(paths, (config) => {
		config.disabledPlugins.push("startup");
		config.openAtLogin = true;
	});
	expect(after.disabledPlugins).toEqual(["startup"]);
	expect(after.bridgeToken).toBe(before.bridgeToken);
	expect((await readConfig(paths)).openAtLogin).toBe(true);
	await expect(mutateConfig(paths, (config) => ({ ...config, bridgePort: 0 }))).rejects.toThrow("bridgePort");
	expect((await readConfig(paths)).bridgePort).toBe(39320);
});

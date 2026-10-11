import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fakePlatform } from "../test/build-context.ts";
import { makeFixtureAsar } from "../test/fixtures.ts";
import { checkAsar } from "./check.ts";

const REAL_ASAR = "/Applications/Grok Bot.app/Contents/Resources/app.asar";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "bgb-check-test-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function checkTempDirs(): Promise<string[]> {
	return (await readdir(tmpdir())).filter((name) => name.startsWith("bgb-check-") && !name.startsWith("bgb-check-test-"));
}

test("reports every core patch against a fixture app and leaves no temp DATA behind", async () => {
	const before = await checkTempDirs();
	const asarPath = await makeFixtureAsar(dir, {
		version: "0.68.1",
		renderer: { "index.html": '<script src="./assets/app.js"></script>', "assets/app.js": "" },
	});
	const report = await checkAsar(asarPath, { platform: fakePlatform() });
	expect(report).toMatchObject({ asar: asarPath, appVersion: "0.68.1", supported: true, ok: false });
	expect(report.plugins.map((plugin) => [plugin.id, plugin.source, plugin.state])).toEqual([
		["bgb-react", "core", "patch-failed"],
		["bgb-settings", "core", "patch-failed"],
		["bgb-client", "core", "patch-failed"],
	]);
	expect(report.plugins[0]?.patches).toEqual([{ id: "react-namespace", matches: 0, expected: 1, ok: false }]);
	expect(await checkTempDirs()).toEqual(before);
});

test("an app without VITE_DEV_SERVER_URL is unsupported", async () => {
	const asarPath = await makeFixtureAsar(dir, { version: "0.70.0", mainHasHook: false, renderer: { "index.html": "<script></script>" } });
	const report = await checkAsar(asarPath, { platform: fakePlatform() });
	expect(report.supported).toBe(false);
	expect(report.ok).toBe(false);
	expect(report.error).toContain("Grok Bot 0.70.0 no longer supports the renderer override");
	const missing = await checkAsar(path.join(dir, "missing.asar"), { platform: fakePlatform() });
	expect(missing).toMatchObject({ appVersion: null, supported: false, ok: false });
});

test.skipIf(!existsSync(REAL_ASAR))("the installed Grok Bot passes every core hook", async () => {
	const report = await checkAsar(REAL_ASAR, { platform: fakePlatform() });
	expect(report.supported).toBe(true);
	const core = report.plugins.filter((plugin) => plugin.source === "core");
	expect(core.map((plugin) => [plugin.id, plugin.state, plugin.errors])).toEqual([
		["bgb-react", "active", []],
		["bgb-settings", "active", []],
		["bgb-client", "active", []],
	]);
	for (const plugin of core) expect(plugin.patches.every((patch) => patch.ok && patch.matches === patch.expected)).toBe(true);
}, 60_000);

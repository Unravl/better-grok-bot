import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CORE_HOOKS } from "../hooks/index.ts";
import { BUNDLED_PLUGINS } from "../plugins/bundled.ts";
import { compareNames } from "../plugins/package.ts";
import { fakePlatform } from "../test/build-context.ts";
import { makeFixtureAsar } from "../test/fixtures.ts";
import { checkAsar } from "./check.ts";

/** Bundled plugin ids in apply order. */
const BUNDLED = BUNDLED_PLUGINS.map((plugin) => plugin.definition).sort((a, b) => compareNames(a.id, b.id));

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

test("reports every core and bundled patch against a fixture app and leaves no temp DATA behind", async () => {
	const before = await checkTempDirs();
	const asarPath = await makeFixtureAsar(dir, {
		version: "0.68.1",
		renderer: { "index.html": '<script src="./assets/app.js"></script>', "assets/app.js": "" },
	});
	const report = await checkAsar(asarPath, { platform: fakePlatform() });
	expect(report).toMatchObject({ asar: asarPath, appVersion: "0.68.1", supported: true, ok: false });
	// The synthetic renderer has none of the app's anchors, so every plugin with patches fails.
	expect(report.plugins.map((plugin) => [plugin.id, plugin.source, plugin.state])).toEqual([
		...CORE_HOOKS.map((def) => [def.id, "core", (def.patches ?? []).length > 0 ? "patch-failed" : "active"]),
		...BUNDLED.map((def) => [def.id, "bundled", (def.patches ?? []).length > 0 ? "patch-failed" : "active"]),
	]);
	expect(report.plugins[0]?.patches).toEqual([{ id: "react-namespace", matches: 0, expected: 1, ok: false }]);
	for (const plugin of report.plugins.slice(CORE_HOOKS.length)) {
		const def = BUNDLED.find((candidate) => candidate.id === plugin.id);
		expect(plugin.patches.map((patch) => patch.id)).toEqual((def?.patches ?? []).map((patch) => patch.id));
	}
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

test.skipIf(!existsSync(REAL_ASAR))("the installed Grok Bot passes every core hook and bundled plugin", async () => {
	const report = await checkAsar(REAL_ASAR, { platform: fakePlatform() });
	expect(report.supported).toBe(true);
	expect(report.plugins.map((plugin) => ({ id: plugin.id, source: plugin.source }))).toEqual([
		...CORE_HOOKS.map((definition) => ({ id: definition.id, source: "core" as const })),
		...BUNDLED.map((definition) => ({ id: definition.id, source: "bundled" as const })),
	]);
	for (const plugin of report.plugins) {
		expect(plugin.state).toBe("active");
		expect(plugin.errors).toEqual([]);
		expect(plugin.patches.every((patch) => patch.ok && patch.matches === patch.expected)).toBe(true);
	}
	expect(report.ok).toBe(true);
}, 60_000);

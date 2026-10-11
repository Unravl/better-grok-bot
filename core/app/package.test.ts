import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { makeFixtureAsar } from "../test/fixtures.ts";
import { readAppPackage } from "./package.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "bgb-app-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("returns the version of a Grok Bot asar", async () => {
	const asarPath = await makeFixtureAsar(dir, { version: "0.68.1", renderer: { "index.html": "<html></html>" } });
	expect(await readAppPackage(asarPath)).toEqual({ version: "0.68.1" });
});

test("rejects an asar that is not Grok Bot", async () => {
	const asarPath = await makeFixtureAsar(dir, { version: "1.0.0", renderer: {}, packageJson: { name: "other" } });
	await expect(readAppPackage(asarPath)).rejects.toThrow(`${asarPath} is not a Grok Bot app.asar`);
	await expect(readAppPackage(path.join(dir, "missing.asar"))).rejects.toThrow("cannot read package.json");
});

test("reads the new version after the asar is replaced at the same path", async () => {
	const asarPath = path.join(dir, "app.asar");
	await makeFixtureAsar(dir, { version: "0.68.1", renderer: { "index.html": "a" }, asarPath });
	expect((await readAppPackage(asarPath)).version).toBe("0.68.1");
	await makeFixtureAsar(dir, {
		version: "0.69.0-beta.1",
		renderer: { "index.html": "a much longer renderer entry so header offsets move", "assets/x.js": "x" },
		asarPath,
	});
	expect((await readAppPackage(asarPath)).version).toBe("0.69.0-beta.1");
});

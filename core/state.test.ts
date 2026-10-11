import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type DataPaths, dataPaths, ensureDataDir } from "./paths.ts";
import { defaultState, mutateState, readState } from "./state.ts";

let paths: DataPaths;

beforeEach(async () => {
	paths = dataPaths(await mkdtemp(path.join(tmpdir(), "bgb-state-")));
	await ensureDataDir(paths);
});

afterEach(async () => {
	await rm(paths.root, { recursive: true, force: true });
});

test("missing state reads as defaults", async () => {
	expect(await readState(paths)).toEqual(defaultState());
});

test("missing keys merge with defaults", async () => {
	await writeFile(paths.state, JSON.stringify({ migratedGrokMods: true, update: { latest: "1.2.3" } }));
	const state = await readState(paths);
	expect(state.migratedGrokMods).toBe(true);
	expect(state.update).toEqual({ checkedAt: null, latest: "1.2.3", pending: null, error: null });
	expect(state.renderers).toEqual([]);
	expect(state.hook).toBeNull();
});

test("mutateState persists edits made in place or returned", async () => {
	await mutateState(paths, (state) => {
		state.lastBuild = { key: "k", appVersion: "0.68.1", builtAt: "now" };
	});
	await mutateState(paths, (state) => ({ ...state, migratedGrokMods: true }));
	const state = await readState(paths);
	expect(state.lastBuild?.key).toBe("k");
	expect(state.migratedGrokMods).toBe(true);
});

test("two processes mutating different fields keep both totals", async () => {
	const child = path.join(import.meta.dir, "test", "mutate-state-child.ts");
	const procs = ["a", "b"].map((name) =>
		Bun.spawn([process.execPath, child, paths.root, name, "200"], { stdout: "inherit", stderr: "inherit" }),
	);
	const codes = await Promise.all(procs.map((proc) => proc.exited));
	expect(codes).toEqual([0, 0]);
	const state = await readState(paths);
	expect(state.notified.a?.length).toBe(200);
	expect(state.notified.b?.length).toBe(200);
}, 120_000);

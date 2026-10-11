import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { withLock } from "./lock.ts";
import { type DataPaths, dataPaths, ensureDataDir } from "./paths.ts";
import { selfIdentity } from "./proc.ts";

let paths: DataPaths;
let lockFile: string;

beforeEach(async () => {
	paths = dataPaths(await mkdtemp(path.join(tmpdir(), "bgb-lock-")));
	await ensureDataDir(paths);
	lockFile = path.join(paths.locks, "state.lock");
});

afterEach(async () => {
	await rm(paths.root, { recursive: true, force: true });
});

test("runs fn, returns its value and releases the lock", async () => {
	const value = await withLock(paths, "state", async () => {
		const record = JSON.parse(await readFile(lockFile, "utf8"));
		expect(record.pid).toBe(process.pid);
		return 42;
	});
	expect(value).toBe(42);
	expect(existsSync(lockFile)).toBe(false);
});

test("releases the lock when fn throws", async () => {
	await expect(withLock(paths, "state", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
	expect(existsSync(lockFile)).toBe(false);
});

test("serializes concurrent holders in one process", async () => {
	let inside = 0;
	let maxInside = 0;
	await Promise.all(
		Array.from({ length: 10 }, () =>
			withLock(paths, "state", async () => {
				inside++;
				maxInside = Math.max(maxInside, inside);
				await readFile(lockFile, "utf8");
				inside--;
			}),
		),
	);
	expect(maxInside).toBe(1);
});

test("a live pid with a different start time is stale", async () => {
	const self = await selfIdentity();
	expect(self.startTime).not.toBeNull();
	const stale = { ...self, startTime: (self.startTime ?? 0) - 3_600_000, at: new Date().toISOString() };
	await writeFile(lockFile, JSON.stringify(stale));
	expect(await withLock(paths, "state", () => "taken", 2_000)).toBe("taken");
});

test("a dead pid is stale", async () => {
	const proc = Bun.spawn(["true"]);
	await proc.exited;
	await writeFile(lockFile, JSON.stringify({ pid: proc.pid, bootId: null, startTime: null, at: "" }));
	expect(await withLock(paths, "state", () => "taken", 2_000)).toBe("taken");
});

test("an unparsable lock is stale only after 5 s", async () => {
	await writeFile(lockFile, "");
	await expect(withLock(paths, "state", () => "taken", 300)).rejects.toThrow(
		"timed out waiting for the state lock (held by pid unknown)",
	);
	const old = new Date(Date.now() - 10_000);
	await utimes(lockFile, old, old);
	expect(await withLock(paths, "state", () => "taken", 300)).toBe("taken");
});

test("a live owner's lock is never taken", async () => {
	const owner = JSON.stringify({ ...(await selfIdentity()), at: "held" });
	await writeFile(lockFile, owner);
	let ran = false;
	await expect(
		withLock(
			paths,
			"state",
			() => {
				ran = true;
			},
			300,
		),
	).rejects.toThrow(`timed out waiting for the state lock (held by pid ${process.pid})`);
	expect(ran).toBe(false);
	expect(await readFile(lockFile, "utf8")).toBe(owner);
});

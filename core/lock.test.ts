import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BgbError } from "./errors.ts";
import { claimRecordFile, releaseRecordFile, withBinariesLock, withLock } from "./lock.ts";
import { type DataPaths, dataPaths, ensureDataDir } from "./paths.ts";
import { bootId, selfIdentity } from "./proc.ts";

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
	const stale = { ...self, startTime: self.startTime - 3_600_000, at: new Date().toISOString() };
	await writeFile(lockFile, JSON.stringify(stale));
	expect(await withLock(paths, "state", () => "taken", 2_000)).toBe("taken");
});

test("a dead pid is stale", async () => {
	await writeFile(lockFile, await deadRecord());
	expect(await withLock(paths, "state", () => "taken", 2_000)).toBe("taken");
});

/** A lock record naming a process that has exited. */
async function deadRecord(): Promise<string> {
	const proc = Bun.spawn([process.execPath, "-e", ""]);
	await proc.exited;
	return JSON.stringify({ pid: proc.pid, bootId: await bootId(), startTime: Date.now(), at: "dead" });
}

test("two reclaimers of one stale record never displace the live holder the first one became", async () => {
	await writeFile(lockFile, await deadRecord());
	const self = await selfIdentity();
	const recordOf = (who: string): string => JSON.stringify({ ...self, at: who });

	// B judges the dead record stale, then stalls before reclaiming it.
	const bJudged = Promise.withResolvers<void>();
	const bResume = Promise.withResolvers<void>();
	const b = claimRecordFile(lockFile, recordOf("b"), {
		judgedStale: async () => {
			bJudged.resolve();
			await bResume.promise;
		},
	});
	await bJudged.promise;

	// A judged the same record stale, reclaimed it and now holds the lock (alive: this process).
	expect(await claimRecordFile(lockFile, recordOf("a"))).toEqual({ claimed: true });
	const held = await stat(lockFile, { bigint: true });

	// B resumes: its reclamation must leave A's record exactly in place (not even moved aside and back).
	bResume.resolve();
	expect(await b).toEqual({ claimed: false, holder: JSON.parse(recordOf("a")) });
	const after = await stat(lockFile, { bigint: true });
	expect([after.ino, after.ctimeNs]).toEqual([held.ino, held.ctimeNs]);
	expect(await readFile(lockFile, "utf8")).toBe(recordOf("a"));
	expect(await claimRecordFile(lockFile, recordOf("c"))).toMatchObject({ claimed: false });

	// A releases: exactly one of the next claimers gets it.
	await releaseRecordFile(lockFile, recordOf("a"));
	const next = await Promise.all([claimRecordFile(lockFile, recordOf("c")), claimRecordFile(lockFile, recordOf("d"))]);
	expect(next.filter((result) => result.claimed)).toHaveLength(1);
	expect(existsSync(`${lockFile}.reclaim`)).toBe(false);
});

test("a reclaim mutex left by a dead reclaimer is reclaimed; a live one is waited for", async () => {
	await writeFile(lockFile, await deadRecord());
	await writeFile(`${lockFile}.reclaim`, await deadRecord());
	expect(await withLock(paths, "state", () => "taken", 2_000)).toBe("taken");
	expect(existsSync(`${lockFile}.reclaim`)).toBe(false);

	const dead = await deadRecord();
	await writeFile(lockFile, dead);
	await writeFile(`${lockFile}.reclaim`, JSON.stringify({ ...(await selfIdentity()), at: "reclaiming" }));
	const judged = Promise.withResolvers<void>();
	const claim = claimRecordFile(lockFile, JSON.stringify({ ...(await selfIdentity()), at: "waiter" }), {
		judgedStale: async () => judged.resolve(),
	});
	await judged.promise;
	// The stale record is only ever removed under the mutex, so it stays while the live reclaimer holds it.
	expect(await readFile(lockFile, "utf8")).toBe(dead);
	await rm(`${lockFile}.reclaim`);
	expect(await claim).toEqual({ claimed: true });
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

test("withBinariesLock is re-entrant in its own call chain and refuses a concurrent transaction", async () => {
	const inside = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const first = withBinariesLock(paths, async () => {
		const nested = await withBinariesLock(paths, async () => "nested");
		inside.resolve();
		await finish.promise;
		return nested;
	});
	await inside.promise;
	let ranSecond = false;
	const second = withBinariesLock(
		paths,
		async () => {
			ranSecond = true;
		},
		50,
	);
	await expect(second).rejects.toBeInstanceOf(BgbError);
	await expect(second).rejects.toMatchObject({ code: "conflict" });
	expect(ranSecond).toBe(false);
	finish.resolve();
	expect(await first).toBe("nested");
	expect(await withBinariesLock(paths, async () => "free again")).toBe("free again");
});

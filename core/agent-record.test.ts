import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { acquireAgentRecord, readLiveAgent, waitForAgent } from "./agent-record.ts";
import { type DataPaths, dataPaths, ensureDataDir } from "./paths.ts";
import { bootId, isAlive, processStartTime, selfIdentity } from "./proc.ts";
import { BGB_VERSION } from "./version.ts";

let paths: DataPaths;

beforeEach(async () => {
	paths = dataPaths(await mkdtemp(path.join(tmpdir(), "bgb-agent-")));
	await ensureDataDir(paths);
});

afterEach(async () => {
	await rm(paths.root, { recursive: true, force: true });
});

test("acquires, reports the live owner, and releases", async () => {
	const first = await acquireAgentRecord(paths, { port: 1234 });
	if (!("acquired" in first)) throw new Error("expected to acquire");
	expect(first.record.pid).toBe(process.pid);
	expect((await readLiveAgent(paths))?.port).toBe(1234);

	const second = await acquireAgentRecord(paths, { port: 1234 });
	expect("owner" in second && second.owner.pid).toBe(process.pid);

	await first.release();
	expect(await readLiveAgent(paths)).toBeNull();
});

test("waits up to waitMs for the owner to release", async () => {
	const first = await acquireAgentRecord(paths, { port: 1 });
	if (!("acquired" in first)) throw new Error("expected to acquire");
	// Real delay: the waiter's poll loop runs on the wall clock and must see the release mid-wait.
	setTimeout(() => void first.release(), 300);
	const second = await acquireAgentRecord(paths, { port: 2, waitMs: 5_000 });
	expect("acquired" in second).toBe(true);
	expect(JSON.parse(await readFile(paths.agentRecord, "utf8")).port).toBe(2);
});

test("replaces a record naming a live unrelated process without signaling it", async () => {
	const sleeper = Bun.spawn(["sleep", "30"]);
	try {
		const start = await processStartTime(sleeper.pid);
		expect(start).not.toBeNull();
		await writeFile(
			paths.agentRecord,
			JSON.stringify({
				pid: sleeper.pid,
				bootId: await bootId(),
				startTime: (start ?? 0) - 3_600_000,
				version: BGB_VERSION,
				port: 39320,
				startedAt: new Date().toISOString(),
			}),
		);
		expect(await readLiveAgent(paths)).toBeNull();
		const result = await acquireAgentRecord(paths, { port: 39320 });
		expect("acquired" in result).toBe(true);
		expect(JSON.parse(await readFile(paths.agentRecord, "utf8")).pid).toBe(process.pid);
		expect(isAlive(sleeper.pid)).toBe(true);
		expect(sleeper.exitCode).toBeNull();
	} finally {
		sleeper.kill();
	}
});

test("waitForAgent polls /health until the expected version answers", async () => {
	let version = "0.0.0";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ name: "better-grok-bot", version, pid: process.pid }),
	});
	try {
		const port = server.port ?? 0;
		// Real delay: waitForAgent polls on the wall clock; the version flips while it is polling.
		setTimeout(() => {
			version = BGB_VERSION;
		}, 400);
		const health = await waitForAgent(paths, port, { version: BGB_VERSION, timeoutMs: 5_000 });
		expect(health).toEqual({ name: "better-grok-bot", version: BGB_VERSION, pid: process.pid });
		await expect(waitForAgent(paths, port, { version: "9.9.9", timeoutMs: 300 })).rejects.toThrow(
			`timed out waiting for agent 9.9.9 on port ${port}`,
		);
	} finally {
		server.stop(true);
	}
});

test("selfIdentity is stable", async () => {
	expect(await selfIdentity()).toBe(await selfIdentity());
});

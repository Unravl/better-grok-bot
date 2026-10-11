import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentRecord } from "../agent-record.ts";
import { ensureConfig } from "../config.ts";
import { type DataPaths, dataPaths, ensureDataDir } from "../paths.ts";
import { bootId, isAlive, processStartTime } from "../proc.ts";
import { stopAgentProcess } from "./agent-control.ts";

let tmp: string;
let paths: DataPaths;
let children: Bun.Subprocess[];

beforeEach(async () => {
	tmp = await mkdtemp(path.join(tmpdir(), "bgb-agentctl-"));
	paths = dataPaths(tmp);
	await ensureDataDir(paths);
	children = [];
});
afterEach(async () => {
	for (const child of children) child.kill("SIGKILL");
	await rm(tmp, { recursive: true, force: true });
});

/** A long-running stand-in agent; `ignoreTerm` makes it survive SIGTERM. */
async function fakeAgent(port: number, ignoreTerm = false): Promise<Bun.Subprocess> {
	const script = `${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""}setInterval(()=>{},1000);console.log('up')`;
	const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe" });
	children.push(child);
	// Wait until the handler is installed before anyone signals it.
	await child.stdout.getReader().read();
	const startTime = await processStartTime(child.pid);
	if (startTime === null) throw new Error("cannot read the fake agent's start time");
	const record: AgentRecord = {
		pid: child.pid,
		bootId: await bootId(),
		startTime,
		version: "0.0.0-test",
		port,
		startedAt: new Date().toISOString(),
	};
	await writeFile(paths.agentRecord, JSON.stringify(record));
	return child;
}

test("no agent → returns at once", async () => {
	await stopAgentProcess(paths);
});

test("POST /shutdown with the bearer token stops the agent", async () => {
	const { bridgeToken } = await ensureConfig(paths);
	let child: Bun.Subprocess | undefined;
	const seen: (string | null)[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			seen.push(request.headers.get("authorization"));
			if (new URL(request.url).pathname === "/shutdown" && request.method === "POST") child?.kill("SIGINT");
			return new Response(null, { status: 202 });
		},
	});
	try {
		child = await fakeAgent(server.port ?? 0);
		await stopAgentProcess(paths, { gracefulMs: 5_000 });
		expect(seen).toEqual([`Bearer ${bridgeToken}`]);
		expect(isAlive(child.pid)).toBe(false);
	} finally {
		server.stop(true);
	}
});

// Windows has no catchable SIGTERM: `process.kill(pid, "SIGTERM")` is TerminateProcess, so no agent survives it.
test.skipIf(process.platform === "win32")("an agent ignoring shutdown and SIGTERM is killed hard", async () => {
	await ensureConfig(paths);
	const child = await fakeAgent(1, true);
	let hard = 0;
	await stopAgentProcess(paths, {
		gracefulMs: 300,
		termMs: 300,
		killHard: async (pid) => {
			hard++;
			process.kill(pid, "SIGKILL");
		},
	});
	expect(hard).toBe(1);
	expect(isAlive(child.pid)).toBe(false);
});

test("requestStop replaces the shutdown request", async () => {
	const child = await fakeAgent(1);
	let requested = 0;
	await stopAgentProcess(paths, {
		requestStop: async (record) => {
			requested++;
			process.kill(record.pid, "SIGTERM");
			return true;
		},
	});
	expect(requested).toBe(1);
	expect(isAlive(child.pid)).toBe(false);
});

test("a recorded pid whose start time differs by even 1 ms, or is missing, is never signaled or sent the token", async () => {
	await ensureConfig(paths);
	const seen: (string | null)[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			seen.push(request.headers.get("authorization"));
			return new Response(null, { status: 202 });
		},
	});
	try {
		const child = await fakeAgent(server.port ?? 0);
		const exact = JSON.parse(await Bun.file(paths.agentRecord).text()) as AgentRecord;
		for (const record of [
			{ ...exact, startTime: exact.startTime + 1 },
			{ ...exact, startTime: exact.startTime - 3_600_000 },
			{ ...exact, startTime: null },
			{ ...exact, startTime: undefined },
		]) {
			await writeFile(paths.agentRecord, JSON.stringify(record));
			await stopAgentProcess(paths, { gracefulMs: 100, termMs: 100, killMs: 100 });
			expect(isAlive(child.pid)).toBe(true);
		}
		expect(seen).toEqual([]);
	} finally {
		server.stop(true);
	}
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createFileLogger } from "./log.ts";
import { type DataPaths, dataPaths, ensureDataDir } from "./paths.ts";

let paths: DataPaths;

beforeEach(async () => {
	paths = dataPaths(await mkdtemp(path.join(tmpdir(), "bgb-log-")));
	await ensureDataDir(paths);
});

afterEach(async () => {
	await rm(paths.root, { recursive: true, force: true });
});

test("writes timestamped level lines; debug only when enabled", async () => {
	createFileLogger(paths, { debug: false }).debug("hidden");
	const log = createFileLogger(paths, { debug: true });
	log.info("hello");
	log.warn("careful");
	log.debug("details");
	const lines = (await readFile(path.join(paths.logs, "agent.log"), "utf8")).trimEnd().split("\n");
	expect(lines).toHaveLength(3);
	expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO  \[\d+\] hello$/);
	expect(lines[1]).toContain("WARN  ");
	expect(lines[2]).toContain("DEBUG [");
});

test("rotates at the size limit keeping two old files", async () => {
	const log = createFileLogger(paths, { maxBytes: 200 });
	for (let i = 0; i < 40; i++) log.info(`line ${i} ${"x".repeat(40)}`);
	const read = (name: string) => readFile(path.join(paths.logs, name), "utf8");
	expect(existsSync(path.join(paths.logs, "agent.1.log"))).toBe(true);
	expect(existsSync(path.join(paths.logs, "agent.2.log"))).toBe(true);
	expect(existsSync(path.join(paths.logs, "agent.3.log"))).toBe(false);
	expect((await read("agent.log")).length).toBeLessThanOrEqual(200);
	expect(await read("agent.log")).toContain("line 39");
});

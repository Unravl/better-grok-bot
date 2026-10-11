import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { followFile } from "./logs.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "bgb-logs-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** followFile polls a real file, so the test polls for its output (real I/O; fake timers can't drive fs). */
async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await Bun.sleep(10);
	}
}

test("followFile streams appended text, restarts after rotation and stops on abort", async () => {
	const file = path.join(dir, "agent.log");
	await writeFile(file, "old line\n");
	const chunks: string[] = [];
	const controller = new AbortController();
	const following = followFile(file, (chunk) => chunks.push(chunk), controller.signal, { from: 9, intervalMs: 10 });
	await appendFile(file, "first\n");
	await until(() => chunks.join("") === "first\n");
	await writeFile(file, "new\n");
	await until(() => chunks.join("") === "first\nnew\n");
	controller.abort();
	await following;
	expect(chunks.join("")).toBe("first\nnew\n");
});

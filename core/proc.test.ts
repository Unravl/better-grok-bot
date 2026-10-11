import { expect, test } from "bun:test";
import * as path from "node:path";
import { type ProcessIdentity, asProcessIdentity, bootId, identityAlive, isAlive, processStartTime, selfIdentity } from "./proc.ts";
import { BGB_COMPILED, BGB_VERSION } from "./version.ts";

test("self identity is alive and started recently", async () => {
	const self = await selfIdentity();
	expect(self.pid).toBe(process.pid);
	expect(Math.abs(self.startTime - performance.timeOrigin)).toBeLessThan(5_000);
	expect(await identityAlive(self)).toBe(true);
	expect(await identityAlive({ ...self, startTime: self.startTime + 60_000 })).toBe(false);
	if (self.bootId !== null) expect(await identityAlive({ ...self, bootId: "other-boot" })).toBe(false);
});

test("start times are compared exactly and an unknown boot never matches", async () => {
	const self = await selfIdentity();
	expect(await identityAlive({ ...self, startTime: self.startTime + 1 })).toBe(false);
	expect(await identityAlive({ ...self, startTime: self.startTime - 1 })).toBe(false);
	if ((await bootId()) !== null) expect(await identityAlive({ ...self, bootId: null })).toBe(false);
});

test("a record without a start time is unverifiable", async () => {
	const self = await selfIdentity();
	expect(asProcessIdentity({ pid: self.pid, bootId: self.bootId, startTime: null })).toBeUndefined();
	expect(asProcessIdentity({ pid: self.pid, bootId: self.bootId })).toBeUndefined();
	expect(asProcessIdentity({ ...self })).toEqual(self);
});

test("another process's self-reported identity matches what this process reads for it", async () => {
	// The child reports its own identity, then stays alive (until killed below) so this process can read it.
	const proc = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const m = await import(${JSON.stringify(path.join(import.meta.dir, "proc.ts"))});` +
				"console.log(JSON.stringify(await m.selfIdentity())); setTimeout(() => {}, 60_000);",
		],
		{ stdout: "pipe", stderr: "inherit" },
	);
	try {
		const reader = proc.stdout.getReader();
		let text = "";
		while (!text.includes("\n")) {
			const { value, done } = await reader.read();
			if (done) break;
			text += new TextDecoder().decode(value);
		}
		const child = JSON.parse(text) as ProcessIdentity;
		expect(child.pid).toBe(proc.pid);
		expect(await processStartTime(proc.pid)).toBe(child.startTime);
		expect(await identityAlive(child)).toBe(true);
	} finally {
		proc.kill();
		await proc.exited;
	}
});

test("an exited process is not alive", async () => {
	const proc = Bun.spawn([process.execPath, "-e", ""]);
	await proc.exited;
	expect(isAlive(proc.pid)).toBe(false);
	expect(await processStartTime(proc.pid)).toBeNull();
	expect(await identityAlive({ pid: proc.pid, bootId: await bootId(), startTime: Date.now() })).toBe(false);
});

test("version flags", () => {
	expect(BGB_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	expect(BGB_COMPILED).toBe(false);
});

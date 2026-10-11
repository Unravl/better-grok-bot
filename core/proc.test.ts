import { expect, test } from "bun:test";
import { identityAlive, isAlive, processStartTime, selfIdentity } from "./proc.ts";
import { BGB_COMPILED, BGB_VERSION } from "./version.ts";

test("self identity is alive and started recently", async () => {
	const self = await selfIdentity();
	expect(self.pid).toBe(process.pid);
	expect(Math.abs((self.startTime ?? 0) - performance.timeOrigin)).toBeLessThan(5_000);
	expect(await identityAlive(self)).toBe(true);
	expect(await identityAlive({ ...self, startTime: (self.startTime ?? 0) + 60_000 })).toBe(false);
	if (self.bootId !== null) expect(await identityAlive({ ...self, bootId: "other-boot" })).toBe(false);
});

test("an exited process is not alive", async () => {
	const proc = Bun.spawn(["true"]);
	await proc.exited;
	expect(isAlive(proc.pid)).toBe(false);
	expect(await processStartTime(proc.pid)).toBeNull();
	expect(await identityAlive({ pid: proc.pid, bootId: null, startTime: null })).toBe(false);
});

test("version flags", () => {
	expect(BGB_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	expect(BGB_COMPILED).toBe(false);
});

import { expect, test } from "bun:test";
import * as path from "node:path";
import type { CheckReport } from "../build/check.ts";
import { runCheck } from "./build.ts";
import { captureIo, commandEnv } from "./testing.ts";

function report(ok: boolean): CheckReport {
	return {
		asar: "/x/app.asar",
		appVersion: "0.68.1",
		supported: true,
		plugins: [
			{
				id: "startup",
				source: "bundled",
				state: ok ? "active" : "patch-failed",
				errors: ok ? [] : ["composer-voice-call: 0 matches, expected 1"],
				patches: [{ id: "composer-voice-call", matches: ok ? 1 : 0, expected: 1, ok }],
			},
		],
		ok,
	};
}

test("check exits 0 when ok and 3 when a plugin fails, without touching DATA", async () => {
	for (const ok of [true, false]) {
		const io = captureIo();
		const asked: string[] = [];
		const code = await runCheck(commandEnv(io, undefined), ["--asar", "rel/app.asar", "--json"], {
			checkAsar: async (asarPath) => {
				asked.push(asarPath);
				return report(ok);
			},
		});
		expect(code).toBe(ok ? 0 : 3);
		expect(asked).toEqual([path.resolve("rel/app.asar")]);
		expect(JSON.parse(io.stdout.join("\n"))).toEqual(report(ok));
	}
});

test("check text output names the failing patch", async () => {
	const io = captureIo();
	const code = await runCheck(commandEnv(io, undefined), ["--asar=/x/app.asar"], { checkAsar: async () => report(false) });
	expect(code).toBe(3);
	expect(io.stdout).toContain("      patch composer-voice-call: 0 match(es), expected 1");
	expect(io.stdout.at(-1)).toBe("FAILED");
});

test("an unsupported asar exits 3", async () => {
	const io = captureIo();
	const unsupported: CheckReport = { asar: "/x/app.asar", appVersion: null, supported: false, error: "no VITE_DEV_SERVER_URL", plugins: [], ok: false };
	expect(await runCheck(commandEnv(io, undefined), ["--asar", "/x/app.asar"], { checkAsar: async () => unsupported })).toBe(3);
	expect(io.stdout).toContain("  renderer override: NOT supported (no VITE_DEV_SERVER_URL)");
});

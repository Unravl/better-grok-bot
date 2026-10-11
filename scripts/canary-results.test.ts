import { describe, expect, test } from "bun:test";
import { classifyEntry, failureTable, NO_RESULT } from "./canary-results.ts";

const okReport = {
	asar: "/x/app.asar",
	appVersion: "0.69.0",
	supported: true,
	plugins: [{ id: "startup", source: "bundled", state: "active", errors: [], patches: [{ id: "a", matches: 1, expected: 1, ok: true }] }],
	ok: true,
};

describe("classifyEntry", () => {
	test("passes when every expected result exists and is clean", () => {
		expect(classifyEntry(okReport, { expected: true, result: { ok: true, failures: [] } })).toEqual({ status: "pass", failures: [] });
		expect(classifyEntry(okReport, { expected: false, result: undefined })).toEqual({ status: "pass", failures: [] });
	});

	test("lists failing patches of core and bundled plugins only", () => {
		const report = {
			...okReport,
			ok: false,
			plugins: [
				{
					id: "push-to-talk",
					source: "bundled",
					state: "patch-failed",
					errors: ["patch call-ui matched 0 times, expected 1"],
					patches: [
						{ id: "call-ui", matches: 0, expected: 1, ok: false },
						{ id: "rows", matches: 1, expected: 1, ok: true },
					],
				},
				{ id: "mine", source: "community", state: "patch-failed", errors: ["x"], patches: [{ id: "p", matches: 0, expected: 1, ok: false }] },
			],
		};
		expect(classifyEntry(report, { expected: false, result: undefined })).toEqual({
			status: "fail",
			failures: [{ check: "compat", pluginId: "push-to-talk", patchId: "call-ui", matches: 0, expected: 1 }],
		});
	});

	test("reports an unsupported app and a plugin failing without a failing patch", () => {
		const report = {
			asar: "/x",
			appVersion: "0.70.0",
			supported: false,
			error: "Grok Bot 0.70.0 no longer reads VITE_DEV_SERVER_URL",
			plugins: [{ id: "bgb-react", source: "core", state: "invalid", errors: ["boom"], patches: [] }],
			ok: false,
		};
		expect(classifyEntry(report, { expected: false, result: undefined }).failures).toEqual([
			{ check: "compat", message: "Grok Bot 0.70.0 no longer reads VITE_DEV_SERVER_URL" },
			{ check: "compat", pluginId: "bgb-react", message: "boom" },
		]);
	});

	test("a missing or unreadable result is an error, not a failure", () => {
		expect(classifyEntry(undefined, { expected: false, result: undefined })).toEqual({
			status: "error",
			failures: [{ check: "compat", message: NO_RESULT }],
		});
		expect(classifyEntry(okReport, { expected: true, result: null }).status).toBe("error");
	});

	test("listed failures win over a missing result", () => {
		const outcome = classifyEntry(undefined, { expected: true, result: { ok: false, failures: ["5 debug launch: timed out"] } });
		expect(outcome.status).toBe("fail");
		expect(outcome.failures).toEqual([
			{ check: "compat", message: NO_RESULT },
			{ check: "e2e", message: "5 debug launch: timed out" },
		]);
	});

	test("ok:false without listed failures still fails", () => {
		expect(classifyEntry(okReport, { expected: true, result: { ok: false, failures: [] } })).toEqual({
			status: "fail",
			failures: [{ check: "e2e", message: "e2e reported ok: false" }],
		});
	});
});

describe("failureTable", () => {
	test("is stable for the same failures and escapes cell separators", () => {
		const rows = [{ key: "linux-x64@0.69.0+abc", status: "fail" as const, failures: [{ check: "e2e", message: "a | b\nc" }] }];
		const table = failureTable(rows);
		expect(table).toBe(failureTable(rows));
		expect(table.split("\n")[2]).toBe("| `linux-x64@0.69.0+abc` | fail | e2e |  |  |  |  | a \\| b c |");
	});
});

import { describe, expect, test } from "bun:test";
import type { EntryStatus } from "./canary-results.ts";
import { brokenKeys, type StateEntry } from "./canary.ts";

function entry(status: EntryStatus): StateEntry {
	return { status, bgbCommit: "b".repeat(40), checkedAt: "2026-10-11T00:00:00.000Z", failures: [], reportedHash: null };
}

describe("brokenKeys", () => {
	test("a republished version resolves when its current commit passes, despite an old failing commit", () => {
		const entries = {
			"linux-x64@1.2.0+old": entry("fail"),
			"linux-x64@1.2.0+new": entry("pass"),
			"darwin-arm64@1.2.0+abc": entry("pass"),
		};
		expect(brokenKeys(entries, ["linux-x64@1.2.0+new", "darwin-arm64@1.2.0+abc"], "1.2.0")).toEqual([]);
	});

	test("lists only current non-passing entries of the version", () => {
		const entries = {
			"linux-x64@1.2.0+old": entry("fail"),
			"linux-x64@1.2.0+new": entry("error"),
			"darwin-arm64@1.2.0+abc": entry("pass"),
			"win32-x64-user@1.2.01+def": entry("fail"),
		};
		const current = ["linux-x64@1.2.0+new", "darwin-arm64@1.2.0+abc", "win32-x64-user@1.2.01+def"];
		expect(brokenKeys(entries, current, "1.2.0")).toEqual(["linux-x64@1.2.0+new"]);
	});
});

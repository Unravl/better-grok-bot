import { describe, expect, test } from "bun:test";
import { botRow, canEdit, pendingSave } from "./runtime.ts";

describe("botRow", () => {
	test("accepts a bot row and defaults a missing description", () => {
		expect(botRow({ id: "a", name: "A" })?.description).toBe("");
		expect(botRow({ id: "a", name: "A", description: "Be brief." })?.description).toBe("Be brief.");
		expect(botRow({ id: "", name: "A" })).toBeNull();
		expect(botRow(null)).toBeNull();
		expect(botRow({ id: "a" })).toBeNull();
	});
});

describe("canEdit", () => {
	test("owners and managers, not group chats or teammates' bots", () => {
		expect(canEdit({ id: "a", name: "A", description: "" })).toBe(true);
		expect(canEdit({ id: "a", name: "A", description: "", viewerIsOwner: false })).toBe(false);
		expect(canEdit({ id: "a", name: "A", description: "", viewerIsOwner: false, viewerCanManage: true })).toBe(true);
		expect(canEdit({ id: "a", name: "A", description: "", isGroup: true })).toBe(false);
	});
});

describe("pendingSave", () => {
	test("trimmed text when it changed, else null", () => {
		expect(pendingSave("Be brief.", "Be brief.  ")).toBeNull();
		expect(pendingSave("Be brief.", " Answer in Thai. ")).toBe("Answer in Thai.");
		expect(pendingSave("Old", "")).toBe("");
	});
});

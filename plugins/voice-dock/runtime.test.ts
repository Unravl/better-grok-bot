import { describe, expect, test } from "bun:test";
import { findAgent, isCallShown, voiceClient } from "./runtime.ts";

describe("voice dock helpers", () => {
	test("shows any call that is not idle", () => {
		expect(isCallShown({ phase: "connecting" })).toBe(true);
		expect(isCallShown({ phase: "failed" })).toBe(true);
		expect(isCallShown({ phase: "idle" })).toBe(false);
		expect(isCallShown(undefined)).toBe(false);
	});

	test("finds the bot in the call", () => {
		expect(findAgent([{ id: "a" }, { id: "b" }], "b")).toEqual({ id: "b" });
		expect(findAgent([{ id: "a" }], "z")).toBeNull();
		expect(findAgent(undefined, "a")).toBeNull();
	});

	test("accepts only a client with the voice-call store and actions", () => {
		const fn = () => {};
		const snapshots = { get: fn, subscribe: fn };
		expect(voiceClient({ voiceCall: { snapshots, toggleMute: fn, hangUp: fn, dismissFailure: fn } })).toBeDefined();
		expect(voiceClient({ voiceCall: { snapshots, toggleMute: fn } })).toBeUndefined();
		expect(voiceClient(null)).toBeUndefined();
	});
});

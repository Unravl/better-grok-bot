import { describe, expect, test } from "bun:test";
import { agentName, callStatus, findAgent, formatElapsed, isCallShown, isStore, voiceClient } from "./runtime.ts";

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
		expect(voiceClient({ voiceCall: { snapshots: { get: fn }, toggleMute: fn, hangUp: fn, dismissFailure: fn } })).toBeUndefined();
		expect(voiceClient(null)).toBeUndefined();
	});

	test("recognizes an app store", () => {
		const fn = () => {};
		expect(isStore({ get: fn, subscribe: fn })).toBe(true);
		expect(isStore({ get: fn })).toBe(false);
		expect(isStore({ get: 1, subscribe: fn })).toBe(false);
		expect(isStore(undefined)).toBe(false);
	});

	test("names the bot from its roster row", () => {
		expect(agentName({ id: "a", name: "  Chief of Staff " })).toBe("Chief of Staff");
		expect(agentName({ id: "a", name: " " })).toBeNull();
		expect(agentName({ id: "a" })).toBeNull();
		expect(agentName(null)).toBeNull();
	});

	test("formats the call timer as the app does", () => {
		expect(formatElapsed(0)).toBe("0:00");
		expect(formatElapsed(7_400)).toBe("0:07");
		expect(formatElapsed(12 * 60_000 + 45_000)).toBe("12:45");
		expect(formatElapsed((3 * 3600 + 12 * 60 + 45) * 1000)).toBe("3:12:45");
		expect(formatElapsed(3600_000 + 5_000)).toBe("1:00:05");
		expect(formatElapsed(-500)).toBe("0:00");
	});

	test("describes each call phase in the status line", () => {
		expect(callStatus({ phase: "connecting" })).toEqual({ tone: "connecting", label: "Connecting…", timed: false });
		expect(callStatus({ phase: "live" })).toEqual({ tone: "connected", label: "Connected", timed: true });
		expect(callStatus({ phase: "live", isMuted: true })).toEqual({ tone: "connected", label: "Muted", timed: true });
		expect(callStatus({ phase: "reconnecting" })).toEqual({ tone: "connecting", label: "Reconnecting…", timed: false });
		expect(callStatus({ phase: "ending" })).toEqual({ tone: "ending", label: "Ending…", timed: false });
		expect(callStatus({ phase: "failed" })).toBeNull();
	});
});

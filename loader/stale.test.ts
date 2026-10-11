import { describe, expect, test } from "bun:test";
import { createBridgeClient } from "./bridge-client.ts";
import { haltIfStaleBuild, MAX_STALE_RELOADS, STALE_CONNECT_MS, STALE_RELOAD_DELAY_MS, STALE_RELOADS_KEY } from "./stale.ts";
import { createFakeSockets, FakeClock, fakeGlobals, recordingLogger } from "./test/fakes.ts";

const UA = (version: string): string =>
	`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) GrokBot/${version} Chrome/142.0.0.0 Electron/42.1.0 Safari/537.36`;

/** In-memory `sessionStorage`. */
function memoryStorage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => {
			values.delete(key);
		},
		setItem: (key, value) => {
			values.set(key, value);
		},
	};
}

function setup(running: string, withBridge: boolean) {
	const clock = new FakeClock();
	const fake = createFakeSockets();
	const session = memoryStorage();
	const log = recordingLogger();
	let stops = 0;
	let reloads = 0;
	const guard = (): boolean =>
		haltIfStaleBuild({
			buildAppVersion: "0.68.1",
			userAgent: UA(running),
			session,
			stop: () => stops++,
			reload: () => reloads++,
			clock,
			openBridge: () =>
				withBridge
					? createBridgeClient({
							port: 39320,
							token: "t",
							buildKey: "old",
							appVersion: running,
							bgbVersion: "0.1.0",
							globals: fakeGlobals(fake.WebSocket),
							clock,
							log,
						})
					: null,
			log,
		});
	return { ...fake, clock, session, log, guard, stops: () => stops, reloads: () => reloads };
}

describe("stale build guard", () => {
	test("does nothing when the UA names the build's version", () => {
		const { guard, session, stops } = setup("0.68.1", true);
		session.setItem(STALE_RELOADS_KEY, "3");
		expect(guard()).toBe(false);
		expect(stops()).toBe(0);
		expect(session.getItem(STALE_RELOADS_KEY)).toBeNull();
	});

	test("without an agent: stops, reloads after 500 ms, and gives up after 30 attempts", () => {
		const { guard, clock, session, reloads, stops, log } = setup("0.69.0", false);
		for (let attempt = 1; attempt <= MAX_STALE_RELOADS; attempt++) {
			expect(guard()).toBe(true);
			expect(session.getItem(STALE_RELOADS_KEY)).toBe(String(attempt));
			clock.advance(STALE_RELOAD_DELAY_MS);
			expect(reloads()).toBe(attempt);
		}
		expect(stops()).toBe(MAX_STALE_RELOADS);
		expect(guard()).toBe(false);
		expect(session.getItem(STALE_RELOADS_KEY)).toBeNull();
		expect(log.lines.some((line) => line.startsWith("error") && line.includes("loading it anyway"))).toBe(true);
	});

	test("falls back to plain reloads when the agent does not connect within 2 s", () => {
		const { guard, clock, reloads, last } = setup("0.69.0", true);
		expect(guard()).toBe(true);
		const socket = last();
		clock.advance(STALE_CONNECT_MS);
		expect(socket.closedWith).toBe(1000);
		expect(reloads()).toBe(0);
		clock.advance(STALE_RELOAD_DELAY_MS);
		expect(reloads()).toBe(1);
	});

	test("asks for a rebuild and reloads on build.finished, even when it arrives before the reply", () => {
		const { guard, clock, reloads, last } = setup("0.69.0", true);
		expect(guard()).toBe(true);
		const socket = last();
		socket.accept();
		socket.welcome("old");
		expect(socket.requests("build.rebuild")).toHaveLength(1);
		socket.event("build.finished", { buildKey: "new", ok: true, appVersion: "0.69.0", failed: [] });
		expect(reloads()).toBe(1);
		expect(socket.closedWith).toBe(1000);
		clock.advance(120_000);
		expect(reloads()).toBe(1);
	});

	test("ignores builds for other versions and reloads after 120 s without one", () => {
		const { guard, clock, reloads, last } = setup("0.69.0", true);
		guard();
		const socket = last();
		socket.accept();
		socket.welcome("old");
		socket.event("build.finished", { buildKey: "other", ok: true, appVersion: "0.68.1", failed: [] });
		expect(reloads()).toBe(0);
		clock.advance(120_000 + STALE_RELOAD_DELAY_MS);
		expect(reloads()).toBe(1);
	});
});

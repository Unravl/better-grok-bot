/** Test support for the agent, bridge, services and update tests (never imported by shipped code). */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentToHelper, BridgeEvent, Platform } from "../../sdk/index.ts";
import { type CoreContext, createContext } from "../context.ts";
import { nullLogger } from "../log.ts";
import type { PlatformAdapter } from "../platform/types.ts";
import type { ServicesHost } from "../services/index.ts";

export type FakePlatform = PlatformAdapter & { calls: string[] };

/** A platform adapter whose every method records its call and does nothing (override as needed). */
export function fakePlatform(id: Platform, overrides: Partial<PlatformAdapter> = {}): FakePlatform {
	const calls: string[] = [];
	const record =
		(name: string) =>
		async (): Promise<void> => {
			calls.push(name);
		};
	return {
		calls,
		id,
		locateApp: async () => {
			throw new Error("no app in tests");
		},
		findRunningApp: async () => undefined,
		quitApp: async () => true,
		launchApp: record("launchApp"),
		hookInstall: async (url) => ({ kind: "user-env", value: url }),
		hookRemove: async () => "removed",
		hookStatus: async () => ({ state: "absent" }),
		autostartInstall: record("autostartInstall"),
		autostartRemove: record("autostartRemove"),
		startAgent: record("startAgent"),
		stopAgent: record("stopAgent"),
		pointCurrent: record("pointCurrent"),
		notify: async (_title, body) => {
			calls.push(`notify:${body}`);
		},
		openPath: async (target) => {
			calls.push(`openPath:${target}`);
		},
		binName: () => "bgb",
		...overrides,
	};
}

/** A fresh `DATA` in a temp dir; `cleanup()` deletes it. */
export async function tempContext(platform: PlatformAdapter): Promise<CoreContext & { cleanup(): Promise<void> }> {
	const root = await mkdtemp(path.join(tmpdir(), "bgb-s3-"));
	const ctx = await createContext({ dataDir: path.join(root, "data"), platform, log: nullLogger });
	return { ...ctx, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A port that was free a moment ago. */
export function freePort(): number {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const port = server.port ?? 0;
	server.stop(true);
	return port;
}

/** Polls `predicate` every 10 ms until it holds; throws after `timeoutMs`. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000, what = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

export interface RecordedEvent {
	connectionId: number;
	event: BridgeEvent;
	data: unknown;
}

export interface RecordingHost {
	events: RecordedEvent[];
	broadcasts: { event: BridgeEvent; data: unknown }[];
	helperFrames: { connectionId: number; message: AgentToHelper }[];
	host: ServicesHost;
}

/** Records what services send to renderers and helpers; `onHelperFrame` lets a fake helper react (e.g. exit on quit). */
export function recordingHost(port = 1, token = "token", onHelperFrame?: (message: AgentToHelper) => void): RecordingHost {
	const recorder: RecordingHost = {
		events: [],
		broadcasts: [],
		helperFrames: [],
		host: {
			sendEvent: (connectionId, event, data) => recorder.events.push({ connectionId, event, data }),
			broadcast: (event, data) => recorder.broadcasts.push({ event, data }),
			sendHelper: (connectionId, message) => {
				recorder.helperFrames.push({ connectionId, message });
				onHelperFrame?.(message);
			},
			endpoint: () => ({ port, token }),
		},
	};
	return recorder;
}

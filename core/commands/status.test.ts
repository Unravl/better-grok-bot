import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { BuildManifest, PluginStatus, ThemeInfo } from "../../sdk/index.ts";
import type { AgentRecord } from "../agent-record.ts";
import { type CoreContext, createContext } from "../context.ts";
import { nullLogger } from "../log.ts";
import type { AppInstall, PlatformAdapter } from "../platform/types.ts";
import { selfIdentity } from "../proc.ts";
import { mutateState } from "../state.ts";
import { BGB_VERSION } from "../version.ts";
import { type StatusDeps, type StatusReport, compareVersions, runStatus, updateStatusFromState } from "./status.ts";
import { captureIo, commandEnv, fakePlatform } from "./testing.ts";

let parent: string;

beforeEach(async () => {
	parent = await mkdtemp(path.join(tmpdir(), "bgb-status-"));
});

afterEach(async () => {
	await rm(parent, { recursive: true, force: true });
});

const APP: AppInstall = { kind: "custom", root: "/apps/Grok Bot", executable: "", asarPath: "/apps/Grok Bot/app.asar", version: "0.68.1" };
const THEMES: ThemeInfo[] = [{ id: "dark", name: "Dark", enabled: true, valid: true }];

function pluginStatus(id: string, state: PluginStatus["state"], errors: string[] = []): PluginStatus {
	return {
		id,
		name: id,
		description: "",
		version: "1.0.0",
		authors: [],
		source: "bundled",
		state,
		errors,
		patches: [],
		permissions: [],
		granted: [],
		settings: {},
		hasRuntime: true,
	};
}

function deps(overrides: Partial<StatusDeps> = {}): StatusDeps & { healthCalls: number[] } {
	const healthCalls: number[] = [];
	return {
		healthCalls,
		resolveApp: async () => APP,
		readBuildManifest: async (_ctx, key, appVersion): Promise<BuildManifest> => ({
			bgbVersion: BGB_VERSION,
			buildFormat: 1,
			buildKey: key,
			platform: "darwin",
			appVersion,
			appFingerprint: "f",
			builtAt: "2026-10-11T00:00:00.000Z",
			plugins: [pluginStatus("startup", "active"), pluginStatus("push-to-talk", "patch-failed", ["anchor moved"])],
			themes: THEMES,
		}),
		listThemes: async () => THEMES,
		health: async (port) => {
			healthCalls.push(port);
			return { name: "better-grok-bot", version: BGB_VERSION, pid: process.pid };
		},
		...overrides,
	};
}

async function context(platform: PlatformAdapter): Promise<CoreContext> {
	return createContext({ dataDir: path.join(parent, "data"), platform, log: nullLogger });
}

/** state.json as a crashed agent leaves it: renderers and services still filled in. */
async function seedState(ctx: CoreContext): Promise<void> {
	await mutateState(ctx.paths, (state) => {
		state.lastBuild = { key: "abcdef0123456789", appVersion: "0.68.1", builtAt: "2026-10-11T00:00:00.000Z" };
		state.renderers = [{ buildKey: "abcdef0123456789", connectedAt: "2026-10-11T00:01:00.000Z" }];
		state.services = { keys: { state: "ready" }, media: { state: "needs-install" } };
	});
}

async function statusJson(ctx: CoreContext, statusDeps: StatusDeps): Promise<StatusReport> {
	const io = captureIo();
	expect(await runStatus(commandEnv(io, ctx), ["--json"], statusDeps)).toBe(0);
	return JSON.parse(io.stdout.join("\n")) as StatusReport;
}

test("status --json without an agent: no renderers, null services, agent not running", async () => {
	const platform = fakePlatform({
		hookStatus: async () => ({ state: "absent" }),
		findRunningApp: async () => undefined,
	});
	const ctx = await context(platform);
	await seedState(ctx);
	const statusDeps = deps();
	const report = await statusJson(ctx, statusDeps);
	expect(Object.keys(report).sort()).toEqual(
		["agent", "app", "bgbVersion", "build", "hook", "keys", "media", "plugins", "renderers", "themes", "update"].sort(),
	);
	expect(report).toEqual({
		bgbVersion: BGB_VERSION,
		agent: { running: false, pid: null, port: null },
		hook: "absent",
		app: { path: "/apps/Grok Bot", version: "0.68.1", running: false },
		renderers: [],
		build: { key: "abcdef0123456789", appVersion: "0.68.1", builtAt: "2026-10-11T00:00:00.000Z" },
		plugins: [
			{ id: "startup", source: "bundled", state: "active", errors: [] },
			{ id: "push-to-talk", source: "bundled", state: "patch-failed", errors: ["anchor moved"] },
		],
		themes: THEMES,
		keys: null,
		media: null,
		update: { state: "disabled", current: BGB_VERSION },
	});
	expect(statusDeps.healthCalls).toEqual([]);
});

test("status --json with a live agent reports its renderers, services and port", async () => {
	const platform = fakePlatform({
		hookStatus: async () => ({ state: "conflict", value: "http://localhost:5173" }),
		findRunningApp: async () => ({ pid: 4242 }),
	});
	const ctx = await context(platform);
	await seedState(ctx);
	const record: AgentRecord = { ...(await selfIdentity()), version: BGB_VERSION, port: 39321, startedAt: new Date().toISOString() };
	await writeFile(ctx.paths.agentRecord, JSON.stringify(record));
	const statusDeps = deps();
	const report = await statusJson(ctx, statusDeps);
	expect(statusDeps.healthCalls).toEqual([39321]);
	expect(report.agent).toEqual({ running: true, pid: process.pid, port: 39321 });
	expect(report.hook).toBe("conflict");
	expect(report.app?.running).toBe(true);
	expect(report.renderers).toEqual([{ buildKey: "abcdef0123456789", connectedAt: "2026-10-11T00:01:00.000Z" }]);
	expect(report.keys).toEqual({ state: "ready" });
	expect(report.media).toEqual({ state: "needs-install" });
});

test("status reports app null when Grok Bot is not found, and plain text names the reason", async () => {
	const platform = fakePlatform({ hookStatus: async () => ({ state: "absent" }) });
	const ctx = await context(platform);
	const statusDeps = deps({
		resolveApp: async () => {
			throw new Error("Grok Bot not found");
		},
	});
	const report = await statusJson(ctx, statusDeps);
	expect(report.app).toBeNull();
	expect(report.build).toBeNull();
	expect(report.plugins).toEqual([]);

	const io = captureIo();
	expect(await runStatus(commandEnv(io, ctx), [], statusDeps)).toBe(0);
	expect(io.stdout).toContain("Grok Bot: not found (Grok Bot not found)");
	expect(io.stdout).toContain("Agent: not running (run: bgb start)");
});

test("compareVersions orders releases and prereleases", () => {
	expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
	expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
	expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
	expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
});

test("update status from a source checkout is disabled", () => {
	expect(updateStatusFromState({ checkedAt: null, latest: "9.9.9", pending: null, error: null })).toEqual({
		state: "disabled",
		current: BGB_VERSION,
	});
});

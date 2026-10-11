import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { BuildManifest, PluginStatus } from "../../sdk/index.ts";
import type { AgentRecord } from "../agent-record.ts";
import type { BuildOutcome } from "../build/index.ts";
import { readConfig } from "../config.ts";
import { type CoreContext, createContext } from "../context.ts";
import { nullLogger } from "../log.ts";
import { rendererUrl } from "../paths.ts";
import type { AppInstall, HookRecord, PlatformAdapter } from "../platform/types.ts";
import { mutateState, readState } from "../state.ts";
import { type SetupDeps, type SetupOptions, runSetup } from "./setup.ts";
import { type Call, type FakeHost, fakeHost, recordingAdapter } from "./test-fakes.ts";

const isWindows = process.platform === "win32";
const BIN_NAME = isWindows ? "bgb.exe" : "bgb";

const APP: AppInstall = {
	kind: "mac-bundle",
	root: "/Applications/Grok Bot.app",
	executable: "/Applications/Grok Bot.app/Contents/MacOS/Grok Bot",
	asarPath: "/Applications/Grok Bot.app/Contents/Resources/app.asar",
	version: "0.68.1",
};

const OPTS: SetupOptions = { yes: false, noRestart: false, force: false, app: null, noAutostart: false, noHook: false };

function plugin(id: string, source: PluginStatus["source"], state: PluginStatus["state"], errors: string[] = []): PluginStatus {
	return {
		id,
		name: id,
		description: "",
		version: "1.0.0",
		authors: [],
		source,
		state,
		errors,
		patches: [],
		permissions: [],
		granted: [],
		settings: {},
		hasRuntime: true,
	};
}

const MANIFEST: BuildManifest = {
	bgbVersion: "0.1.0",
	buildFormat: 1,
	buildKey: "k".repeat(64),
	platform: "darwin",
	appVersion: "0.68.1",
	appFingerprint: "f",
	builtAt: "2026-10-11T00:00:00.000Z",
	plugins: [
		plugin("bgb-react", "core", "active"),
		plugin("push-to-talk", "bundled", "active"),
		plugin("startup", "bundled", "patch-failed", ["anchor missed"]),
	],
	themes: [],
};

const LIVE_AGENT: AgentRecord = {
	pid: 999_999,
	bootId: null,
	startTime: 0,
	version: "0.1.0",
	port: 39320,
	startedAt: "2026-10-11T00:00:00.000Z",
};

let root: string;
let calls: Call[];
let host: FakeHost;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "bgb-setup-"));
	calls = [];
	host = fakeHost(path.join(root, "home"), { powershell: (script) => (script.includes("SetEnvironmentVariable") ? "added" : "") });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function context(adapter: Partial<PlatformAdapter> = {}): Promise<CoreContext> {
	return createContext({ dataDir: path.join(root, "data"), platform: recordingAdapter(calls, adapter), log: nullLogger });
}

/** Fakes for everything setup reaches beyond the adapter; each records its call in `calls`. */
function deps(overrides: Partial<SetupDeps> = {}): Partial<SetupDeps> {
	const note = (name: string, ...args: unknown[]): void => {
		calls.push({ name, args });
	};
	return {
		host,
		compiled: true,
		execPath: path.join(root, "download", BIN_NAME),
		resolveApp: async (_ctx, explicit) => {
			note("resolveApp", explicit);
			return APP;
		},
		checkSupport: async () => note("checkSupport"),
		build: async (ctx, options): Promise<BuildOutcome> => {
			note("build", options);
			return { key: MANIFEST.buildKey, dir: path.join(ctx.paths.builds, "0.68.1-kkkk"), manifest: MANIFEST, cached: false, warnings: [] };
		},
		stageBinaries: async (ctx) => {
			note("stageBinaries");
			const dir = path.join(ctx.paths.bin, ".staged-test");
			await mkdir(dir, { recursive: true });
			return dir;
		},
		commitBinaries: async (ctx, staged) => {
			note("commitBinaries");
			await rm(staged, { recursive: true, force: true });
			await writeFile(path.join(ctx.paths.bin, BIN_NAME), "new");
		},
		restorePrevious: async () => note("restorePrevious"),
		removeBinaries: async () => note("removeBinaries"),
		readLiveAgent: async () => null,
		waitForAgent: async (_paths, port, opts) => {
			note("waitForAgent", port, opts);
			return { name: "better-grok-bot", version: "0.1.0", pid: 1 };
		},
		...overrides,
	};
}

const names = (): string[] => calls.map((call) => call.name);

async function installOldBinary(ctx: CoreContext): Promise<void> {
	await mkdir(ctx.paths.bin, { recursive: true });
	await writeFile(path.join(ctx.paths.bin, BIN_NAME), "old");
}

test("a failing hook install undoes autostart, the agent, the binaries and the previous agent stop in reverse", async () => {
	const ctx = await context({
		hookInstall: async () => {
			throw new Error("hook exploded");
		},
	});
	await installOldBinary(ctx);

	const code = await runSetup(ctx, { ...OPTS, app: path.join(root, "Grok Bot.app") }, deps({ readLiveAgent: async () => LIVE_AGENT }));

	expect(code).toBe(1);
	expect(names()).toEqual([
		"resolveApp",
		"checkSupport",
		"build",
		"stageBinaries",
		"hookStatus",
		"stopAgent",
		"commitBinaries",
		"autostartInstall",
		"startAgent",
		"waitForAgent",
		"hookInstall",
		// undo, newest first
		"stopAgent",
		"autostartRemove",
		"restorePrevious",
		"startAgent",
	]);
	expect(host.err.at(-1)).toBe("bgb: hook exploded");
	expect((await readConfig(ctx.paths)).appPath).toBeNull();
	expect((await readState(ctx.paths)).hook).toBeNull();
	if (isWindows) expect(host.scripts.length).toBe(2);
	else expect(existsSync(path.join(host.home, ".local", "bin", "bgb"))).toBe(false);
});

test("a first install that fails removes the installed binaries instead of restoring previous ones", async () => {
	const ctx = await context({
		startAgent: async () => {
			throw new Error("spawn failed");
		},
	});

	expect(await runSetup(ctx, OPTS, deps())).toBe(1);

	expect(names().slice(names().indexOf("startAgent"))).toEqual(["startAgent", "autostartRemove", "removeBinaries"]);
	expect(host.err.at(-1)).toBe("bgb: spawn failed");
});

test("a foreign VITE_DEV_SERVER_URL aborts setup before any change", async () => {
	const ctx = await context({ hookStatus: async () => ({ state: "conflict", value: "http://localhost:5173/" }) });

	const code = await runSetup(ctx, { ...OPTS, app: path.join(root, "Grok Bot.app") }, deps({ readLiveAgent: async () => LIVE_AGENT }));

	expect(code).toBe(1);
	expect(host.err).toEqual([
		"bgb: VITE_DEV_SERVER_URL is already set to http://localhost:5173/ by something else. Remove it, then run setup again.",
	]);
	expect(names()).toEqual(["resolveApp", "checkSupport", "build", "stageBinaries", "hookStatus"]);
	expect(await readdir(ctx.paths.bin)).toEqual([]);
	expect((await readConfig(ctx.paths)).appPath).toBeNull();
	expect(existsSync(path.join(host.home, ".local", "bin", "bgb"))).toBe(false);
	expect(host.scripts).toEqual([]);
});

test("Grok Bot missing fails preflight with the install hint", async () => {
	const ctx = await context();
	const code = await runSetup(
		ctx,
		OPTS,
		deps({
			resolveApp: async () => {
				throw new Error("no Grok Bot.app");
			},
		}),
	);
	expect(code).toBe(1);
	expect(host.err).toEqual(["bgb: Grok Bot not found. Install it from https://x.ai/bot or pass --app <path> (no Grok Bot.app)"]);
	expect(names()).toEqual([]);
});

test("--no-hook removes an existing Better Grok Bot hook", async () => {
	const ctx = await context();
	await installOldBinary(ctx);
	const record: HookRecord = { kind: "launchctl", value: rendererUrl(ctx.paths) };
	await mutateState(ctx.paths, (state) => {
		state.hook = record;
	});

	const code = await runSetup(ctx, { ...OPTS, noHook: true }, deps({ compiled: false }));

	expect(code).toBe(0);
	expect(names()).not.toContain("hookInstall");
	expect(names()).not.toContain("hookStatus");
	expect(calls.find((call) => call.name === "hookRemove")?.args).toEqual([record]);
	expect((await readState(ctx.paths)).hook).toBeNull();
	expect(host.out).toContain("No hook installed (--no-hook): run `bgb restart` to start Grok Bot with Better Grok Bot.");
});

test("a successful setup installs everything, records the hook and restarts a running Grok Bot", async () => {
	const ctx = await context({
		findRunningApp: async () => ({ pid: 4242 }),
		hookInstall: async (hookUrl) => ({ kind: "launchctl", value: hookUrl }),
	});
	const appArg = path.join(root, "Grok Bot.app");

	const code = await runSetup(ctx, { ...OPTS, yes: true, app: appArg }, deps());

	expect(code).toBe(0);
	expect(names()).toEqual([
		"resolveApp",
		"checkSupport",
		"build",
		"stageBinaries",
		"hookStatus",
		"commitBinaries",
		"autostartInstall",
		"startAgent",
		"waitForAgent",
		"hookInstall",
		"findRunningApp",
		"findRunningApp",
		"quitApp",
		"launchApp",
	]);
	expect(calls[0]?.args).toEqual([appArg]);
	const url = rendererUrl(ctx.paths);
	expect(calls.find((call) => call.name === "launchApp")?.args).toEqual([APP, { VITE_DEV_SERVER_URL: url }, []]);
	expect((await readState(ctx.paths)).hook).toEqual({ kind: "launchctl", value: url });
	expect((await readConfig(ctx.paths)).appPath).toBe(appArg);
	if (!isWindows) expect(await readlink(path.join(host.home, ".local", "bin", "bgb"))).toBe(path.join(ctx.paths.bin, "bgb"));
	expect(host.out).toContain("  ✗ startup (startup) patch-failed: anchor missed");
	expect(host.out).toContain("  ✓ push-to-talk (push-to-talk) active");
	expect(host.out.some((line) => line.includes("bgb-react"))).toBe(false);
	expect(host.out.at(-1)).toBe("Open Grok Bot → Settings → General → Better Grok Bot");
});

test("--no-restart leaves a running Grok Bot alone and says so", async () => {
	const ctx = await context({ findRunningApp: async () => ({ pid: 4242 }) });
	expect(await runSetup(ctx, { ...OPTS, yes: true, noRestart: true, noAutostart: true }, deps())).toBe(0);
	expect(names()).not.toContain("quitApp");
	expect(names()).not.toContain("autostartInstall");
	expect(host.out).toContain("Restart Grok Bot to load Better Grok Bot.");
});

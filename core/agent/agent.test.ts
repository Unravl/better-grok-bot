import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { zipSync } from "fflate";
import { type BridgeEvents, type BuildManifest, HELPER_CODES, type PluginStatus, type ThemeInfo } from "../../sdk/index.ts";
import { waitForAgent } from "../agent-record.ts";
import { type BridgeClient, connectBridge, openWebSocket } from "../bridge/client.ts";
import { type Config, mutateConfig, readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { BgbError } from "../errors.ts";
import type { CommandRunner } from "../services/command.ts";
import { HELPER_APP_NAME, HELPER_LABEL } from "../services/helper.ts";
import { mutateState, readState } from "../state.ts";
import { sha256Hex } from "../update/download.ts";
import type { BinaryOps } from "../update/self-update.ts";
import { BGB_VERSION } from "../version.ts";
import type { AgentDeps } from "./agent.ts";
import { runAgent, runSelfTest } from "./main.ts";
import type { BuildOutcomeInfo, CoreOps } from "./ops.ts";
import { type FakePlatform, fakePlatform, freePort, tempContext, waitFor } from "./testing.ts";

let platform: FakePlatform;
let ctx: CoreContext & { cleanup(): Promise<void> };
let config: Config;
const clients: BridgeClient[] = [];
const sockets: WebSocket[] = [];
const agents: Promise<number>[] = [];
const TIMEOUT = 30_000;

beforeEach(async () => {
	platform = fakePlatform("darwin");
	ctx = await tempContext(platform);
	const port = freePort();
	config = await mutateConfig(ctx.paths, (draft) => {
		draft.bridgePort = port;
	});
});

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const socket of sockets.splice(0)) socket.close();
	await shutdownAgent();
	await Promise.all(agents.splice(0));
	await ctx.cleanup();
});

async function shutdownAgent(): Promise<void> {
	await fetch(`http://127.0.0.1:${(await readConfig(ctx.paths)).bridgePort}/shutdown`, {
		method: "POST",
		headers: { Authorization: `Bearer ${config.bridgeToken}` },
	}).catch(() => undefined);
}

function plugin(id: string, state: PluginStatus["state"]): PluginStatus {
	return {
		id,
		name: id,
		description: "",
		version: "1.0.0",
		authors: [],
		source: id.startsWith("bgb-") ? "core" : "bundled",
		state,
		errors: [],
		patches: [],
		permissions: [],
		granted: [],
		settings: {},
		hasRuntime: false,
	};
}

interface FakeOps extends CoreOps {
	builds: { key: string; port: number; protect: string[] }[];
}

function fakeOps(themes: ThemeInfo[] = []): FakeOps {
	let manifest: BuildManifest | null = null;
	const builds: FakeOps["builds"] = [];
	return {
		builds,
		async build(c, options): Promise<BuildOutcomeInfo> {
			const current = await readConfig(c.paths);
			const inputs = JSON.stringify([current.bridgePort, current.disabledPlugins, current.enabledThemes]);
			const key = sha256Hex(new TextEncoder().encode(inputs));
			builds.push({ key, port: current.bridgePort, protect: options?.protect ?? [] });
			manifest = {
				bgbVersion: BGB_VERSION,
				buildFormat: 1,
				buildKey: key,
				platform: "darwin",
				appVersion: "0.68.1",
				appFingerprint: "f",
				builtAt: new Date().toISOString(),
				plugins: [
					plugin("bgb-react", "active"),
					plugin("voice-keepalive", current.disabledPlugins.includes("voice-keepalive") ? "disabled" : "active"),
					plugin("startup", "patch-failed"),
				],
				themes,
			};
			return { key, dir: path.join(c.paths.builds, key.slice(0, 12)), manifest, cached: false, warnings: [] };
		},
		readCurrentManifest: async () => manifest,
		resolveApp: async () => ({
			kind: "custom",
			root: "/Applications/Grok Bot.app",
			executable: "",
			asarPath: "/Applications/Grok Bot.app/Contents/Resources/app.asar",
			version: "0.68.1",
		}),
		inspectSource: async () => {
			throw new BgbError("not-found", "no such source");
		},
		installInspected: async () => ({ id: "demo" }),
		uninstallPlugin: async () => {},
		updatePlugin: async () => ({ state: "current" }),
		readDevDirs: async () => [],
		listThemes: async (_c, cfg) => themes.map((theme) => ({ ...theme, enabled: cfg.enabledThemes.includes(theme.id) })),
		themeStyles: async (_c, cfg) =>
			themes.filter((theme) => theme.valid && cfg.enabledThemes.includes(theme.id)).map((theme) => ({ id: theme.id, css: `/*${theme.id}*/` })),
	};
}

const commands: string[][] = [];
const run: CommandRunner = async (argv) => {
	commands.push([...argv]);
	return { code: 0, stdout: "", stderr: "" };
};

function deps(ops: CoreOps, extra: Partial<AgentDeps> = {}): Partial<AgentDeps> {
	return {
		ops,
		run,
		respawn: () => {},
		underLaunchd: false,
		services: {
			launchAgentsDir: path.join(ctx.paths.root, "LaunchAgents"),
			env: {},
			uid: 501,
			manifest: { version: 1, tag: "helper-v1", assets: { "darwin-universal": { name: "h.zip", sha256: "a".repeat(64) } } },
		},
		update: { compiled: false },
		appPollMs: 60_000,
		dataDebounceMs: 30,
		handleSignals: false,
		...extra,
	};
}

/** Starts the agent and waits for /health; `running` resolves with its exit code. (Wrapped: an async function returning the promise itself would wait for the agent to exit.) */
async function startAgent(ops: CoreOps, extra: Partial<AgentDeps> = {}): Promise<{ running: Promise<number> }> {
	const running = runAgent(ctx, { replace: false }, deps(ops, extra));
	agents.push(running);
	await waitForAgent(ctx.paths, config.bridgePort, { version: BGB_VERSION, timeoutMs: 5_000 });
	return { running };
}

async function client(buildKey?: string): Promise<BridgeClient> {
	const connected = await connectBridge(ctx.paths, buildKey ? { buildKey } : {});
	clients.push(connected);
	return connected;
}

function collect<E extends keyof BridgeEvents>(bridgeClient: BridgeClient, event: E): BridgeEvents[E][] {
	const seen: BridgeEvents[E][] = [];
	bridgeClient.on(event, (data) => seen.push(data));
	return seen;
}

async function installMacHelper(): Promise<void> {
	const launchAgents = path.join(ctx.paths.root, "LaunchAgents");
	await mkdir(launchAgents, { recursive: true });
	await writeFile(path.join(launchAgents, `${HELPER_LABEL}.plist`), "<plist/>");
	const macos = path.join(ctx.paths.helpers, HELPER_APP_NAME, "Contents", "MacOS");
	await mkdir(macos, { recursive: true });
	await writeFile(path.join(macos, "bgb-helper"), "");
	await writeFile(path.join(ctx.paths.helpers, "version.txt"), "1\n");
}

function connectHelper(port: number): { ws: WebSocket; frames: unknown[]; open: Promise<void> } {
	const ws = openWebSocket(`ws://127.0.0.1:${port}/helper`, { Authorization: `Bearer ${config.bridgeToken}` });
	sockets.push(ws);
	const frames: unknown[] = [];
	const open = Promise.withResolvers<void>();
	ws.onopen = () => open.resolve();
	ws.onerror = () => open.reject(new Error("helper socket error"));
	ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
	return { ws, frames, open: open.promise };
}

test("serves the bridge methods, tracks renderers (not CLI clients) and shuts down cleanly", async () => {
	const ops = fakeOps([
		{ id: "dark", name: "Dark", enabled: false, valid: true },
		{ id: "broken", name: "broken.theme.css", enabled: false, valid: false, error: "missing @name header" },
	]);
	const { running } = await startAgent(ops);
	await waitFor(() => ops.builds.length === 1, 5_000, "initial build");
	expect(platform.calls).toContain("notify:Better Grok Bot: 1 plugin(s) need an update for Grok Bot 0.68.1: startup");
	await waitFor(async () => "0.68.1" in (await readState(ctx.paths)).notified, 5_000, "notified record");
	expect((await readState(ctx.paths)).notified).toEqual({ "0.68.1": ["startup"] });

	const renderer = await client("renderer-key");
	expect(renderer.welcome.currentBuildKey).toBe(ops.builds[0]?.key ?? "");
	const cli = await client();
	await waitFor(async () => (await readState(ctx.paths)).renderers.length === 1, 5_000, "renderer in state");
	expect((await readState(ctx.paths)).renderers.map((r) => r.buildKey)).toEqual(["renderer-key"]);

	await expect(cli.request("plugins.setEnabled", { id: "bgb-react", enabled: false })).rejects.toMatchObject({ code: "bad-request" });
	await expect(cli.request("keys.watch", { codes: ["KeyA"] })).rejects.toMatchObject({ code: "bad-request" });
	expect(await cli.request("keys.watch", { codes: ["AltRight", "F22"] })).toEqual({ unsupported: ["F22"] });
	await expect(cli.request("plugins.inspect", { source: "nowhere" })).rejects.toMatchObject({ code: "not-found" });

	const finished = collect(renderer, "build.finished");
	const started = collect(renderer, "build.started");
	expect(await cli.request("plugins.setEnabled", { id: "voice-keepalive", enabled: false })).toEqual({});
	expect((await readConfig(ctx.paths)).disabledPlugins).toEqual(["voice-keepalive"]);
	await waitFor(() => finished.length === 1, 5_000, "rebuild after disabling");
	expect(started.length).toBeGreaterThanOrEqual(1);
	expect(finished[0]).toEqual({ buildKey: ops.builds[1]?.key ?? "", ok: true, appVersion: "0.68.1", failed: ["startup"] });
	expect(finished[0]?.buildKey).not.toBe(ops.builds[0]?.key);
	expect(ops.builds[1]?.protect).toEqual(["renderer-key"]);

	const themesChanged = collect(renderer, "themes.changed");
	await expect(cli.request("themes.setEnabled", { id: "broken", enabled: true })).rejects.toMatchObject({ code: "bad-request" });
	await expect(cli.request("themes.setEnabled", { id: "ghost", enabled: true })).rejects.toMatchObject({ code: "not-found" });
	await cli.request("themes.setEnabled", { id: "dark", enabled: true });
	await waitFor(() => themesChanged.length >= 1, 5_000, "themes.changed");
	expect(themesChanged[0]).toEqual({ styles: [{ id: "dark", css: "/*dark*/" }] });
	expect(await cli.request("themes.styles", {})).toEqual({ styles: [{ id: "dark", css: "/*dark*/" }] });

	await cli.request("settings.set", { key: "autoUpdate", value: false });
	await expect(cli.request("settings.set", { key: "bridgePort", value: true } as never)).rejects.toMatchObject({ code: "bad-request" });
	expect((await readConfig(ctx.paths)).autoUpdate).toBe(false);
	await cli.request("system.openPath", { target: "themes" });
	expect(platform.calls).toContain(`openPath:${ctx.paths.themes}`);
	expect(await cli.request("update.check", {})).toEqual({ state: "disabled", current: BGB_VERSION });

	const status = await cli.request("status.get", {});
	expect(status).toMatchObject({
		bgbVersion: BGB_VERSION,
		platform: "darwin",
		app: { version: "0.68.1", path: "/Applications/Grok Bot.app" },
		settings: { openAtLogin: false, autoUpdate: false },
		keys: { state: "needs-install" },
		media: { state: "needs-install" },
		update: { state: "disabled" },
	});
	expect(status.plugins.map((p) => [p.id, p.state])).toEqual([
		["bgb-react", "active"],
		["voice-keepalive", "disabled"],
		["startup", "patch-failed"],
	]);
	expect(status.themes.find((theme) => theme.id === "dark")?.enabled).toBe(true);

	const response = await fetch(`http://127.0.0.1:${config.bridgePort}/shutdown`, {
		method: "POST",
		headers: { Authorization: `Bearer ${config.bridgeToken}` },
	});
	expect(response.status).toBe(202);
	expect(await running).toBe(0);
	const state = await readState(ctx.paths);
	expect(state.renderers).toEqual([]);
	expect(state.services).toBeNull();
	expect(existsSync(ctx.paths.agentRecord)).toBe(false);
}, TIMEOUT);

test("a connection opened after a helper hello with keys:denied reads needs-permission from status.get", async () => {
	await installMacHelper();
	const { running } = await startAgent(fakeOps());
	const helper = connectHelper(config.bridgePort);
	await helper.open;
	helper.ws.send(
		JSON.stringify({ type: "hello", protocol: 4, platform: "darwin", keys: "denied", codes: [...HELPER_CODES.darwin], media: true }),
	);
	await waitFor(async () => (await readState(ctx.paths)).services?.keys.state === "needs-permission", 5_000, "state.json");
	const late = await client("late-renderer");
	const status = await late.request("status.get", {});
	expect(status.keys.state).toBe("needs-permission");
	expect(status.media).toEqual({ state: "ready" });
	expect(helper.frames).toEqual([
		{ type: "watch", codes: [] },
		{ type: "duck", ducked: false, level: 1 },
	]);
	await shutdownAgent();
	expect(await running).toBe(0);
}, TIMEOUT);

test("a new bridgePort rebuilds, sends bridge.moving before closing, then applies the restart rule", async () => {
	await installMacHelper();
	const ops = fakeOps();
	const respawned: string[] = [];
	const { running } = await startAgent(ops, { respawn: (c) => void respawned.push(c.paths.root) });
	await waitFor(() => ops.builds.length === 1, 5_000, "initial build");
	const renderer = await client("renderer-key");
	const order: string[] = [];
	renderer.on("bridge.moving", (data) => order.push(`moving:${data.port}`));
	renderer.onClose(() => order.push("closed"));
	const helper = connectHelper(config.bridgePort);
	await helper.open;
	helper.ws.send(
		JSON.stringify({ type: "hello", protocol: 4, platform: "darwin", keys: "granted", codes: [...HELPER_CODES.darwin], media: true }),
	);
	await waitFor(() => helper.frames.length === 2, 5_000, "helper hello frames");

	const newPort = freePort();
	await mutateConfig(ctx.paths, (draft) => {
		draft.bridgePort = newPort;
	});
	expect(await running).toBe(0);
	expect(ops.builds.map((b) => b.port)).toEqual([config.bridgePort, newPort]);
	expect(ops.builds[1]?.key).not.toBe(ops.builds[0]?.key);
	await waitFor(() => order.includes("closed"), 5_000, "renderer close");
	expect(order).toEqual([`moving:${newPort}`, "closed"]);
	expect(respawned).toEqual([ctx.paths.root]);
	expect(helper.frames.slice(2)).toEqual([
		{ type: "duck", ducked: false, level: 1 },
		{ type: "watch", codes: [] },
	]);
	expect(existsSync(ctx.paths.agentRecord)).toBe(false);
}, TIMEOUT);

test("macOS: the agent re-exports the hook at start unless something else owns the variable", async () => {
	await mutateState(ctx.paths, (draft) => {
		draft.hook = { kind: "launchctl", value: "file:///x/current/renderer/index.html?bgb" };
	});
	commands.length = 0;
	const { running } = await startAgent(fakeOps());
	expect(commands.slice(0, 2)).toEqual([
		["launchctl", "getenv", "VITE_DEV_SERVER_URL"],
		["launchctl", "setenv", "VITE_DEV_SERVER_URL", "file:///x/current/renderer/index.html?bgb"],
	]);
	await shutdownAgent();
	expect(await running).toBe(0);
}, TIMEOUT);

test("a second agent exits 0 while one runs; a busy port exits 1 and releases the record", async () => {
	const { running } = await startAgent(fakeOps());
	expect(await runAgent(ctx, { replace: false }, deps(fakeOps()))).toBe(0);
	await shutdownAgent();
	expect(await running).toBe(0);

	const squatter = Bun.serve({ hostname: "127.0.0.1", port: config.bridgePort, fetch: () => new Response("hi") });
	const errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(await runAgent(ctx, { replace: false }, deps(fakeOps()))).toBe(1);
		expect(String(errors.mock.calls[0]?.[0])).toContain(`port ${config.bridgePort} is in use by another program`);
		expect(existsSync(ctx.paths.agentRecord)).toBe(false);
	} finally {
		errors.mockRestore();
		squatter.stop(true);
	}
}, TIMEOUT);

test("agent --self-test serves /health on an ephemeral port and prints ok <version>", async () => {
	const logs = spyOn(console, "log").mockImplementation(() => {});
	try {
		expect(await runSelfTest(ctx)).toBe(0);
		expect(logs.mock.calls).toEqual([[`ok ${BGB_VERSION}`]]);
	} finally {
		logs.mockRestore();
	}
	expect(existsSync(ctx.paths.agentRecord)).toBe(false);
});

test("two concurrent update.apply requests run one install transaction and keep the rollback copy", async () => {
	// A Windows layout, so the release is a zip that installs without external tools.
	await ctx.cleanup();
	platform = fakePlatform("win32", { binName: () => "bgb.exe" });
	ctx = await tempContext(platform);
	const port = freePort();
	config = await mutateConfig(ctx.paths, (draft) => {
		draft.bridgePort = port;
		draft.autoUpdate = false;
	});
	await mkdir(ctx.paths.bin, { recursive: true });
	await writeFile(path.join(ctx.paths.bin, "bgb.exe"), "old");

	const NEW = "9.9.9";
	const archive = zipSync({ "bgb.exe": new TextEncoder().encode("new") });
	const base = `https://github.com/Unravl/better-grok-bot/releases/download/v${NEW}`;
	const sumsRequested = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let sumsDownloads = 0;
	const fetchFn = async (input: string | URL | Request): Promise<Response> => {
		const url = String(input);
		if (url === "https://api.github.com/repos/Unravl/better-grok-bot/releases/latest") return Response.json({ tag_name: `v${NEW}` });
		if (url === `${base}/SHA256SUMS`) {
			sumsDownloads++;
			sumsRequested.resolve();
			await release.promise;
			return new Response(`${sha256Hex(archive)}  bgb-windows-x64.zip\n`);
		}
		if (url === `${base}/bgb-windows-x64.zip`) return new Response(archive);
		return new Response("missing", { status: 404 });
	};
	const transactions: string[] = [];
	const binaries: BinaryOps = {
		async stageBinaries(c, srcDir) {
			transactions.push("stage");
			const staged = path.join(c.paths.bin, `.staged-${transactions.length}`);
			await mkdir(staged, { recursive: true });
			await copyFile(path.join(srcDir, "bgb.exe"), path.join(staged, "bgb.exe"));
			return staged;
		},
		// Mirrors the real transaction: discard previous/, move the installed binary into it, install the staged one.
		async commitBinaries(c, staged) {
			transactions.push("commit");
			await rm(c.paths.binPrevious, { recursive: true, force: true });
			await mkdir(c.paths.binPrevious, { recursive: true });
			await rename(path.join(c.paths.bin, "bgb.exe"), path.join(c.paths.binPrevious, "bgb.exe"));
			await rename(path.join(staged, "bgb.exe"), path.join(c.paths.bin, "bgb.exe"));
			await rm(staged, { recursive: true, force: true });
		},
		async restorePrevious() {
			transactions.push("restore");
		},
	};
	const spawned: string[][] = [];
	const { running } = await startAgent(fakeOps(), {
		update: {
			compiled: true,
			fetch: fetchFn,
			arch: "x64",
			binaries: async () => binaries,
			run: async (argv) => (argv.includes("--self-test") ? { code: 0, stdout: `ok ${NEW}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" }),
			spawnDetached: (argv) => spawned.push([...argv]),
		},
	});
	const cli = await client();

	const first = cli.request("update.apply", {});
	await sumsRequested.promise;
	const second = cli.request("update.apply", {});
	// Requests on one connection are dispatched in order, so once this answers, the second apply has started.
	await cli.request("status.get", {});
	release.resolve();
	expect(await Promise.all([first, second])).toEqual([{}, {}]);

	expect(sumsDownloads).toBe(1);
	expect(transactions).toEqual(["stage", "commit"]);
	expect(await readFile(path.join(ctx.paths.binPrevious, "bgb.exe"), "utf8")).toBe("old");
	expect(await readFile(path.join(ctx.paths.bin, "bgb.exe"), "utf8")).toBe("new");
	expect(spawned.map((argv) => argv.slice(1, 3))).toEqual([["update-watchdog", "--expect"]]);
	expect((await readState(ctx.paths)).update.pending?.version).toBe(NEW);
	expect(await running).toBe(0);
}, TIMEOUT);

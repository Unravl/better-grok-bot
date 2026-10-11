#!/usr/bin/env bun
/**
 * End-to-end test of a release archive against the real Grok Bot (CI runners only):
 *
 *   bun scripts/e2e.ts --archive <bgb-…tar.gz|zip> --sums <SHA256SUMS> --feed-platform <darwin-arm64|win32-x64-user|linux-x64>
 *
 * Prerequisites: Grok Bot installed by `fetch-upstream.ts --install`; on Linux an X server
 * (`DISPLAY`) and a session bus (`dbus-run-session -- bun scripts/e2e.ts …`). Uses the default
 * `DATA` location, installs through `install.sh`/`install.ps1`, drives the app through normal
 * launchers, CDP and the bridge, and finally uninstalls with `--purge`. Writes and prints
 * `e2e-<feedPlatform>.json` = `{ok, failures}`; exits 1 when any check failed.
 *
 * `BGB_SETUP_ARGS=--no-autostart` (macOS contingency when `launchctl bootstrap` fails on the
 * runner) is passed to setup and skips the login simulation.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { hookedUrl, parseExec, unwrapEnv } from "../core/platform/desktop-entry.ts";
import { dataPaths, defaultDataDir, rendererUrl } from "../core/paths.ts";
import { runPowerShell } from "../core/powershell.ts";
import { BRIDGE_PROTOCOL, type HelloFrame } from "../sdk/index.ts";
import { mergeEnv, REPO_ROOT, run, runMain, ScriptError, TIMED_OUT, within } from "./lib.ts";

// ---------------------------------------------------------------------------------------------
// Fixed identities (PLAN "Shared contracts")

const AGENT_LABEL = "io.github.unravl.bettergrokbot.agent";
const LOGIN_LABEL = "io.github.unravl.bettergrokbot.login";
const MAC_BUNDLE_ID = "com.anysphere.sand";
const HOOK_ENV = "VITE_DEV_SERVER_URL";
const DEBUG_PORT = 9333;
const MOVED_PORT = 39321;
const CORE_AND_BUNDLED = ["bgb-react", "bgb-settings", "bgb-client", "bgb-brand", "bot-instructions", "chat-search", "output-device", "push-to-talk", "sidebar-folders", "startup", "voice-dock", "voice-keepalive", "weekly-usage"];
const LINUX_MARKER = "X-BetterGrokBot-Original-Exec";

const os = process.platform;
const paths = dataPaths(defaultDataDir());
const bin = path.join(paths.bin, os === "win32" ? "bgb.exe" : "bgb");
const xdgDataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
const linuxHookFile = path.join(xdgDataHome, "applications", "grok-bot.desktop");
const linuxAutostartFile = path.join(xdgConfigHome, "autostart", "better-grok-bot.desktop");
const macPlist = (label: string): string => path.join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const winExe = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Grok Bot", "Grok Bot.exe");

// ---------------------------------------------------------------------------------------------
// Small utilities

function log(message: string): void {
	console.error(`[e2e] ${message}`);
}

/** Calls `fn` until it returns a non-null value; throws after `timeoutMs` with the last error. */
async function poll<T>(what: string, timeoutMs: number, fn: () => Promise<T | null>, intervalMs = 1_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError = "";
	for (;;) {
		try {
			const value = await fn();
			if (value !== null) return value;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		if (Date.now() >= deadline) {
			throw new ScriptError(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${lastError ? ` (last error: ${lastError})` : ""}`);
		}
		await Bun.sleep(intervalMs);
	}
}

function check(condition: boolean, message: string): asserts condition {
	if (!condition) throw new ScriptError(message);
}

async function bgb(args: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}): Promise<string> {
	const result = await run([bin, ...args], { allowFail: opts.allowFail, timeoutMs: opts.timeoutMs ?? 120_000 });
	return result.stdout;
}

/** `bgb status --json` (S8 contract). */
interface StatusJson {
	bgbVersion: string;
	agent: { running: boolean; pid: number | null; port: number | null };
	hook: "active" | "absent" | "conflict";
	app: { path: string; version: string; running: boolean } | null;
	renderers: { buildKey: string; connectedAt: string }[];
	build: { key: string; appVersion: string; builtAt: string } | null;
	plugins: { id: string; source: string; state: string; errors: string[] }[];
	keys: { state: string; detail?: string } | null;
	media: { state: string; detail?: string } | null;
}

async function status(): Promise<StatusJson> {
	// Output of the binary under test; the fields read here are asserted where used.
	const parsed = JSON.parse(await bgb(["status", "--json"], { timeoutMs: 60_000 })) as StatusJson;
	return parsed;
}

async function readConfigFile(): Promise<{ port: number; token: string }> {
	const parsed: unknown = JSON.parse(await readFile(paths.config, "utf8"));
	if (
		!parsed ||
		typeof parsed !== "object" ||
		!("bridgePort" in parsed) ||
		typeof parsed.bridgePort !== "number" ||
		!("bridgeToken" in parsed) ||
		typeof parsed.bridgeToken !== "string"
	) {
		throw new ScriptError(`${paths.config} has no bridgePort/bridgeToken`);
	}
	return { port: parsed.bridgePort, token: parsed.bridgeToken };
}

async function agentHealthy(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
		if (!response.ok) return false;
		const body: unknown = await response.json();
		return !!body && typeof body === "object" && "name" in body && body.name === "better-grok-bot";
	} catch {
		return false;
	}
}

/** Basenames of every running process. */
async function processNames(): Promise<string[]> {
	if (os === "win32") {
		const out = (await run(["tasklist", "/FO", "CSV", "/NH"])).stdout;
		return out
			.split(/\r?\n/)
			.map((line) => /^"([^"]+)"/.exec(line)?.[1] ?? "")
			.filter(Boolean);
	}
	const out = (await run(["ps", "-A", "-o", "comm="])).stdout;
	return out
		.split("\n")
		.map((line) => path.basename(line.trim()))
		.filter(Boolean);
}

const HELPER_PROCESS = /^bgb-helper/i;
const BGB_PROCESS = /^bgbw?(\.exe)?$/i;

async function launchctlGetenv(): Promise<string> {
	return (await run(["launchctl", "getenv", HOOK_ENV], { allowFail: true })).stdout.trim();
}

async function windowsUserHookValue(): Promise<string> {
	return runPowerShell(`[Environment]::GetEnvironmentVariable('${HOOK_ENV}','User')`);
}

/** Whether `native/helper-manifest.json` publishes a helper for this OS/arch. */
async function helperPublished(): Promise<boolean> {
	const key = os === "win32" ? `windows-${process.arch}` : `linux-${process.arch}`;
	const parsed: unknown = JSON.parse(await readFile(path.join(REPO_ROOT, "native", "helper-manifest.json"), "utf8"));
	return !!parsed && typeof parsed === "object" && "assets" in parsed && !!parsed.assets && typeof parsed.assets === "object" && key in parsed.assets;
}

// ---------------------------------------------------------------------------------------------
// WebSocket clients: Chrome DevTools Protocol and the BGB bridge

interface Frame {
	[key: string]: unknown;
	type?: unknown;
}

function parseFrame(data: unknown): Frame | null {
	try {
		const parsed: unknown = JSON.parse(String(data));
		return parsed && typeof parsed === "object" ? (parsed as Frame) : null;
	} catch {
		return null;
	}
}

class Cdp {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: Frame) => void; reject: (error: Error) => void }>();

	private constructor(private readonly ws: WebSocket) {
		ws.addEventListener("message", (event) => {
			const frame = parseFrame(event.data);
			if (!frame || typeof frame.id !== "number") return;
			const waiter = this.pending.get(frame.id);
			if (!waiter) return;
			this.pending.delete(frame.id);
			waiter.resolve(frame);
		});
		ws.addEventListener("close", () => {
			for (const waiter of this.pending.values()) waiter.reject(new Error("CDP connection closed"));
			this.pending.clear();
		});
	}

	static async connect(url: string): Promise<Cdp> {
		const ws = new WebSocket(url);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				ws.close();
				reject(new Error(`could not connect to ${url} within 10 s`));
			}, 10_000);
			ws.addEventListener(
				"open",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
			ws.addEventListener(
				"error",
				() => {
					clearTimeout(timer);
					reject(new Error(`could not connect to ${url}`));
				},
				{ once: true },
			);
		});
		return new Cdp(ws);
	}

	/** `Runtime.evaluate` by value; throws on a JS exception or after 15 s. */
	async evaluate(expression: string): Promise<unknown> {
		if (this.ws.readyState !== WebSocket.OPEN) throw new Error("CDP connection closed");
		const id = this.nextId++;
		const response = await new Promise<Frame>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Runtime.evaluate timed out: ${expression}`));
			}, 15_000);
			this.pending.set(id, {
				resolve: (frame) => {
					clearTimeout(timer);
					resolve(frame);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
		});
		const result = response.result;
		if (response.error || !result || typeof result !== "object") throw new Error(`CDP error: ${JSON.stringify(response.error ?? response)}`);
		if ("exceptionDetails" in result && result.exceptionDetails) {
			throw new Error(`evaluation threw: ${JSON.stringify(result.exceptionDetails).slice(0, 500)}`);
		}
		const remote = "result" in result ? result.result : undefined;
		return remote && typeof remote === "object" && "value" in remote ? remote.value : undefined;
	}

	close(): void {
		this.ws.close();
	}
}

interface BridgeEventRecord {
	name: string;
	data: unknown;
}

/** Raw bridge client, as a renderer would connect (Origin `file://`). */
class Bridge {
	readonly events: BridgeEventRecord[] = [];
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (frame: Frame) => void; reject: (error: Error) => void }>();
	closed = false;

	private constructor(private readonly ws: WebSocket) {}

	static async connect(port: number, token: string, hello: Omit<HelloFrame, "type" | "protocol" | "token">): Promise<Bridge> {
		// Bun's WebSocket takes `{headers}`; lib.dom's constructor type (also in this tsconfig) does not.
		const BunWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
		const ws = new BunWebSocket(`ws://127.0.0.1:${port}/bgb`, { headers: { Origin: "file://" } });
		const bridge = new Bridge(ws);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no welcome from the bridge on port ${port} within 10 s`)), 10_000);
			ws.addEventListener("open", () => {
				const frame: HelloFrame = { type: "hello", protocol: BRIDGE_PROTOCOL, token, ...hello };
				ws.send(JSON.stringify(frame));
			});
			ws.addEventListener("message", (event) => {
				const frame = parseFrame(event.data);
				if (!frame) return;
				if (frame.type === "welcome") {
					clearTimeout(timer);
					resolve();
				} else if (frame.type === "event" && typeof frame.name === "string") {
					bridge.events.push({ name: frame.name, data: frame.data });
				} else if (frame.type === "res" && typeof frame.id === "number") {
					const waiter = bridge.pending.get(frame.id);
					bridge.pending.delete(frame.id);
					waiter?.resolve(frame);
				}
			});
			ws.addEventListener("close", (event) => {
				bridge.closed = true;
				clearTimeout(timer);
				reject(new Error(`bridge closed (${event.code}) before welcome`));
				for (const waiter of bridge.pending.values()) waiter.reject(new Error("bridge connection closed"));
				bridge.pending.clear();
			});
		});
		return bridge;
	}

	/** Sends one request and returns its result; throws on `ok:false`, a close or after `timeoutMs`. */
	async request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
		const id = this.nextId++;
		const frame = await new Promise<Frame>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.ws.send(JSON.stringify({ type: "req", id, method, params }));
		});
		if (frame.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(frame.error)}`);
		return frame.result;
	}

	/** First event at index ≥ `from` matching `match`. */
	async waitForEvent(what: string, timeoutMs: number, match: (event: BridgeEventRecord) => boolean, from = 0): Promise<{ event: BridgeEventRecord; index: number }> {
		return poll(
			what,
			timeoutMs,
			async () => {
				for (let index = from; index < this.events.length; index++) {
					const event = this.events[index];
					if (event && match(event)) return { event, index };
				}
				return null;
			},
			100,
		);
	}

	close(): void {
		this.ws.close();
	}
}

function keysState(event: BridgeEventRecord): string | null {
	const data = event.data;
	return event.name === "keys.state" && data && typeof data === "object" && "state" in data && typeof data.state === "string" ? data.state : null;
}

// ---------------------------------------------------------------------------------------------
// App control

async function appRunning(): Promise<boolean> {
	return (await status()).app?.running === true;
}

async function quitApp(): Promise<void> {
	if (!(await appRunning())) return;
	log("quitting Grok Bot");
	if (os === "darwin") await run(["osascript", "-e", `tell application id "${MAC_BUNDLE_ID}" to quit`], { allowFail: true });
	else if (os === "win32") await run(["taskkill", "/IM", "Grok Bot.exe"], { allowFail: true });
	else await run(["pkill", "-TERM", "-x", "grok-bot"], { allowFail: true });
	try {
		await poll("Grok Bot to quit", 20_000, async () => ((await appRunning()) ? null : true));
	} catch {
		log("Grok Bot did not quit; killing it");
		if (os === "darwin") await run(["pkill", "-9", "-f", "/Grok Bot.app/Contents/MacOS/"], { allowFail: true });
		else if (os === "win32") await run(["taskkill", "/F", "/T", "/IM", "Grok Bot.exe"], { allowFail: true });
		else await run(["pkill", "-KILL", "-x", "grok-bot"], { allowFail: true });
		await poll("Grok Bot to exit", 15_000, async () => ((await appRunning()) ? null : true));
	}
	// Let the single-instance lock go before the next launch.
	await Bun.sleep(2_000);
}

/** Spawns a GUI process that outlives this script. */
function spawnDetached(cmd: string[], env: Record<string, string | undefined>): void {
	const proc = Bun.spawn(cmd, { env: mergeEnv(env), detached: true, stdio: ["ignore", "ignore", "ignore"], windowsHide: false });
	proc.unref();
}

let launches = 0;

/**
 * Runs a launcher (`open`, `explorer.exe`, `gtk-launch`) that starts Grok Bot and exits. Its output
 * goes to files, never to a pipe: the app it starts inherits the launcher's stdout/stderr, so reading
 * a pipe to end-of-file would wait for the app to quit.
 */
async function launch(cmd: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}): Promise<void> {
	const base = path.join(tmpdir(), `bgb-e2e-launch-${process.pid}-${++launches}`);
	const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: Bun.file(`${base}.out`), stderr: Bun.file(`${base}.err`) });
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const code = await within(proc.exited, timeoutMs);
	if (code === TIMED_OUT) proc.kill();
	if (code !== 0 && (code === TIMED_OUT || !opts.allowFail)) {
		const output = [await Bun.file(`${base}.err`).text().catch(() => ""), await Bun.file(`${base}.out`).text().catch(() => "")]
			.map((text) => text.trim())
			.filter(Boolean)
			.join("\n");
		const outcome = code === TIMED_OUT ? `did not exit within ${timeoutMs / 1000} s` : `exited with ${code}`;
		throw new ScriptError(`${cmd.join(" ")} ${outcome}${output ? `:\n${output}` : ""}`);
	}
}

/** Linux: the hooked desktop entry's program and arguments (field codes dropped) plus its URL. */
async function linuxHookedCommand(): Promise<{ argv: string[]; url: string }> {
	const text = await readFile(linuxHookFile, "utf8");
	const url = hookedUrl(text);
	if (!url) throw new ScriptError(`${linuxHookFile} is not hooked`);
	let inEntry = false;
	let exec: string | null = null;
	for (const line of text.split(/\r?\n/)) {
		if (/^\[.*\]$/.test(line.trim())) inEntry = line.trim() === "[Desktop Entry]";
		else if (inEntry && line.startsWith("Exec=")) exec = line.slice("Exec=".length);
	}
	if (exec === null) throw new ScriptError(`${linuxHookFile} has no [Desktop Entry] Exec`);
	const argv = unwrapEnv(parseExec(exec))
		.filter((token: string) => !/^%[a-zA-Z]$/.test(token))
		.map((token: string) => token.replaceAll("%%", "%"));
	return { argv, url };
}

/** Launches Grok Bot the way a user would, without a debug port. */
async function normalLaunch(): Promise<void> {
	if (os === "darwin") {
		await launch(["open", "-a", "Grok Bot"]);
	} else if (os === "win32") {
		// explorer.exe exits non-zero even when it launched the program.
		await launch(["explorer.exe", winExe], { allowFail: true });
		try {
			await poll("Grok Bot to start from explorer.exe", 20_000, async () => ((await appRunning()) ? true : null));
		} catch {
			log("explorer.exe did not launch Grok Bot; launching it directly with the User value");
			spawnDetached([winExe], { [HOOK_ENV]: await windowsUserHookValue() });
		}
	} else {
		await launch(["gtk-launch", "grok-bot"]);
	}
}

/** Launches Grok Bot with `--remote-debugging-port` and the hook environment. */
async function debugLaunch(): Promise<void> {
	const flag = `--remote-debugging-port=${DEBUG_PORT}`;
	if (os === "darwin") {
		await launch(["open", "-a", "Grok Bot", "--args", flag]);
	} else if (os === "win32") {
		spawnDetached([winExe, flag], { [HOOK_ENV]: await windowsUserHookValue() });
	} else {
		const { argv, url } = await linuxHookedCommand();
		spawnDetached([...argv, flag], { [HOOK_ENV]: url });
	}
}

async function findPage(): Promise<string> {
	return poll("the patched renderer page on the debug port", 90_000, async () => {
		const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(3_000) });
		const targets: unknown = await response.json();
		if (!Array.isArray(targets)) return null;
		for (const target of targets as unknown[]) {
			if (!target || typeof target !== "object") continue;
			const type = "type" in target ? target.type : undefined;
			const url = "url" in target ? target.url : undefined;
			const ws = "webSocketDebuggerUrl" in target ? target.webSocketDebuggerUrl : undefined;
			if (type === "page" && typeof url === "string" && url.includes("/current/renderer/index.html?bgb") && typeof ws === "string") return ws;
		}
		return null;
	});
}

// ---------------------------------------------------------------------------------------------
// Main

await runMain("e2e", async () => {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: { archive: { type: "string" }, sums: { type: "string" }, "feed-platform": { type: "string" } },
		strict: true,
	});
	const feedPlatform = values["feed-platform"];
	if (!values.archive || !values.sums || !feedPlatform) {
		throw new ScriptError("usage: bun scripts/e2e.ts --archive <path> --sums <path> --feed-platform <p>", 2);
	}
	if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
		throw new ScriptError("e2e.ts is for CI runners: it installs, restarts and uninstalls Better Grok Bot and quits Grok Bot");
	}
	const archive = path.resolve(values.archive);
	const sums = path.resolve(values.sums);
	const setupArgs = process.env.BGB_SETUP_ARGS ?? "";
	const noAutostart = setupArgs.split(/\s+/).includes("--no-autostart");

	const failures: string[] = [];
	let aborted = false;
	/** Runs one check; a throw or its deadline (default 180 s) records a failure instead of ending the run. */
	const step = async (name: string, fn: () => Promise<void>, opts: { critical?: boolean; timeoutMs?: number } = {}): Promise<boolean> => {
		if (aborted) return false;
		const timeoutMs = opts.timeoutMs ?? 180_000;
		log(`▶ ${name}`);
		const started = Date.now();
		try {
			// A step past its deadline keeps running in the background; the run moves on regardless.
			if ((await within(fn(), timeoutMs)) === TIMED_OUT) throw new ScriptError(`step deadline of ${timeoutMs / 1000} s exceeded`);
			log(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log(`✗ ${name}: ${message}`);
			failures.push(`${name}: ${message}`);
			if (opts.critical) aborted = true;
			return false;
		}
	};

	// Mutated inside step closures, so kept in an object (no stale control-flow narrowing).
	const live: { cdp: Cdp | null; clientA: Bridge | null; uninstalled: boolean } = { cdp: null, clientA: null, uninstalled: false };
	const requireCdp = (): Cdp => {
		if (!live.cdp) throw new ScriptError("no CDP session (the debug launch failed)");
		return live.cdp;
	};
	const bridges: Bridge[] = [];
	const tmp = await mkdtemp(path.join(tmpdir(), "bgb-e2e-"));

	try {
		await step(
			"1 install",
			async () => {
				const env: Record<string, string | undefined> = { BGB_LOCAL_ARCHIVE: archive, BGB_LOCAL_SUMS: sums };
				// Linux leaves BGB_NONINTERACTIVE unset so install.sh's /dev/tty probe must choose by itself.
				if (os !== "linux") env.BGB_NONINTERACTIVE = "1";
				const command =
					os === "win32"
						? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(REPO_ROOT, "install.ps1")]
						: ["sh", path.join(REPO_ROOT, "install.sh")];
				await run(command, { env, inherit: true, timeoutMs: 600_000 });
				check(existsSync(bin), `${bin} does not exist after the install`);
			},
			{ critical: true, timeoutMs: 660_000 },
		);

		await step(
			"2 status after install",
			async () => {
				const current = await poll("agent.running and hook active", 30_000, async () => {
					const value = await status();
					return value.agent.running && value.hook === "active" ? value : null;
				});
				check(current.build !== null, "status has no build");
			},
			{ critical: true },
		);

		if (noAutostart) {
			log("skipping the login simulation (BGB_SETUP_ARGS has --no-autostart)");
		} else {
			await step("3 login simulation", async () => {
				const hookUrl = rendererUrl(paths);
				if (os === "darwin") {
					const uid = process.getuid?.() ?? 0;
					await run(["launchctl", "bootout", `gui/${uid}/${AGENT_LABEL}`], { allowFail: true });
					await poll("the agent to stop", 20_000, async () => ((await agentHealthy((await readConfigFile()).port)) ? null : true));
					await run(["launchctl", "unsetenv", HOOK_ENV]);
					await run(["launchctl", "bootstrap", `gui/${uid}`, macPlist(AGENT_LABEL)]);
					await run(["launchctl", "bootstrap", `gui/${uid}`, macPlist(LOGIN_LABEL)]);
					await poll("a healthy agent and the re-exported hook", 30_000, async () =>
						(await agentHealthy((await readConfigFile()).port)) && (await launchctlGetenv()) === hookUrl ? true : null,
					);
				} else {
					await bgb(["stop"], { timeoutMs: 60_000 });
					await poll("the agent to stop", 20_000, async () => ((await agentHealthy((await readConfigFile()).port)) ? null : true));
					if (os === "win32") {
						const command = await runPowerShell(
							"(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'BetterGrokBot').BetterGrokBot",
						);
						check(command.trim() !== "", "the BetterGrokBot Run value is empty");
						// Captured on purpose: bgbw.exe → `bgb login` → agent must not keep cmd's stdout/stderr open.
						await run(["cmd.exe", "/d", "/s", "/c", `"${command.trim()}"`], { windowsVerbatimArguments: true, timeoutMs: 60_000 });
					} else {
						check(existsSync(linuxAutostartFile), `${linuxAutostartFile} does not exist`);
						// Captured on purpose: `bgb login` → agent must not keep gio's stdout/stderr open.
						await run(["gio", "launch", linuxAutostartFile], { timeoutMs: 60_000 });
					}
					await poll("a healthy agent", 30_000, async () => ((await agentHealthy((await readConfigFile()).port)) ? true : null));
				}
			}, { timeoutMs: 240_000 });
		}

		await step("4 normal launch", async () => {
			await quitApp();
			await normalLaunch();
			const key = (await status()).build?.key;
			check(!!key, "status has no build key");
			await poll(`a renderer on build ${key}`, 90_000, async () => ((await status()).renderers.some((r) => r.buildKey === key) ? true : null), 2_000);
			await quitApp();
		}, { timeoutMs: 300_000 });

		await step("5 debug launch", async () => {
			await quitApp();
			await debugLaunch();
			live.cdp = await Cdp.connect(await findPage());
		}, { timeoutMs: 240_000 });

		await step("6 runtime state over CDP", async () => {
			const page = requireCdp();
			await poll("every core and bundled plugin active", 30_000, async () => {
				const states = await page.evaluate("BetterGrokBot.status().map((p) => [p.id, p.state])");
				if (!Array.isArray(states)) return null;
				const byId = new Map((states as unknown[]).filter(Array.isArray).map((entry) => [String(entry[0]), String(entry[1])]));
				const inactive = CORE_AND_BUNDLED.filter((id) => byId.get(id) !== "active");
				if (inactive.length > 0) throw new Error(`not active: ${inactive.map((id) => `${id}=${byId.get(id) ?? "missing"}`).join(", ")}`);
				return true;
			});
			await poll("BetterGrokBot.bridgeState() === connected", 30_000, async () =>
				(await page.evaluate("BetterGrokBot.bridgeState()")) === "connected" ? true : null,
			);
			await poll("BetterGrokBot.React", 30_000, async () => ((await page.evaluate("!!BetterGrokBot.React")) === true ? true : null));
		});

		await step("7 mutation and reload", async () => {
			const page = requireCdp();
			const current = await status();
			check(current.build !== null && current.app !== null, "status has no build or app");
			const { port, token } = await readConfigFile();
			const client = await Bridge.connect(port, token, {
				buildKey: current.build.key,
				appVersion: current.app.version,
				bgbVersion: current.bgbVersion,
			});
			bridges.push(client);
			try {
				let previousKey = current.build.key;
				for (const enabled of [false, true]) {
					const from = client.events.length;
					await client.request("plugins.setEnabled", { id: "voice-keepalive", enabled });
					const { event } = await client.waitForEvent(`build.finished with a new key (voice-keepalive ${enabled ? "on" : "off"})`, 120_000, (e) => {
						const data = e.data;
						return (
							e.name === "build.finished" &&
							!!data &&
							typeof data === "object" &&
							"buildKey" in data &&
							data.buildKey !== previousKey &&
							"ok" in data &&
							data.ok === true
						);
					}, from);
					const data = event.data;
					check(!!data && typeof data === "object" && "buildKey" in data && typeof data.buildKey === "string", "build.finished without a buildKey");
					const newKey = data.buildKey;
					await page.evaluate("location.reload()");
					const expected = enabled ? "active" : "disabled";
					await poll(`voice-keepalive ${expected} in a renderer on ${newKey}`, 120_000, async () => {
						const state = await page.evaluate('BetterGrokBot.status().find((p) => p.id === "voice-keepalive")?.state ?? null');
						if (state !== expected) return null;
						return (await status()).renderers.some((r) => r.buildKey === newKey) ? true : null;
					}, 2_000);
					previousKey = newKey;
				}
			} finally {
				client.close();
			}
		}, { timeoutMs: 600_000 });

		await step("8 live theme", async () => {
			const page = requireCdp();
			const themeFile = path.join(tmp, "e2e.theme.css");
			await writeFile(themeFile, "/** @name E2E */ :root{--bgb-e2e:1}\n");
			await bgb(["themes", "install", themeFile]);
			await page.evaluate("window.__bgbE2eNoReload = 1");
			const query = `!!document.querySelector('style[data-bgb-style="theme:e2e"]')`;
			await bgb(["themes", "enable", "e2e"]);
			await poll("the e2e theme style", 10_000, async () => ((await page.evaluate(query)) === true ? true : null), 250);
			await bgb(["themes", "disable", "e2e"]);
			await poll("the e2e theme style to go away", 10_000, async () => ((await page.evaluate(query)) === false ? true : null), 250);
			check((await page.evaluate("window.__bgbE2eNoReload === 1")) === true, "the page reloaded while toggling a theme");
		});

		const expectHelper = os !== "darwin" && (await helperPublished());
		if (os !== "darwin" && !expectHelper) {
			log("native/helper-manifest.json publishes no helper for this platform: expecting keys.state unsupported, skipping helper process checks");
		}
		const helperRunning = async (): Promise<boolean> => (await processNames()).some((name) => HELPER_PROCESS.test(name));
		const keysStateOf = (agentStatus: unknown): unknown =>
			agentStatus && typeof agentStatus === "object" && "keys" in agentStatus && agentStatus.keys && typeof agentStatus.keys === "object" && "state" in agentStatus.keys
				? agentStatus.keys.state
				: undefined;
		let bgbVersion = "";
		let appVersion = "0.0.0";

		await step("9 helper lifecycle", async () => {
			const current = await status();
			bgbVersion = current.bgbVersion;
			appVersion = current.app?.version ?? "0.0.0";
			const { port, token } = await readConfigFile();
			const a = await Bridge.connect(port, token, { buildKey: "cli", appVersion, bgbVersion });
			bridges.push(a);
			live.clientA = a;
			const from = a.events.length;
			const result = await a.request("keys.watch", { codes: ["AltRight"] });
			check(JSON.stringify(result) === JSON.stringify({ unsupported: [] }), `keys.watch returned ${JSON.stringify(result)}`);
			if (expectHelper) {
				const starting = await a.waitForEvent("keys.state starting", 60_000, (e) => keysState(e) === "starting", from);
				await a.waitForEvent("keys.state ready", 60_000, (e) => keysState(e) === "ready", starting.index + 1);
				await poll("a bgb-helper process", 10_000, async () => ((await helperRunning()) ? true : null));
				const b = await Bridge.connect(port, token, { buildKey: "cli", appVersion, bgbVersion });
				try {
					const state = keysStateOf(await b.request("status.get", {}));
					check(state === "ready", `a later client reads keys.state ${String(state)}`);
				} finally {
					b.close();
				}
			} else {
				const expected = os === "darwin" ? "needs-install" : "unsupported";
				await Bun.sleep(3_000);
				const state = keysStateOf(await a.request("status.get", {}));
				check(state === expected, `keys.state is ${String(state)}, expected ${expected}`);
			}
		}, { timeoutMs: 240_000 });

		await step("10 port move", async () => {
			const a = live.clientA;
			check(a !== null, "client A is not connected (step 9 failed)");
			const page = requireCdp();
			const { token } = await readConfigFile();
			await page.evaluate("window.__bgbE2eNoReload = 1");
			const from = a.events.length;
			await bgb(["config", "set", "bridgePort", String(MOVED_PORT)]);
			await a.waitForEvent(`bridge.moving {port:${MOVED_PORT}}`, 60_000, (e) => {
				const data = e.data;
				return e.name === "bridge.moving" && !!data && typeof data === "object" && "port" in data && data.port === MOVED_PORT;
			}, from);
			a.close();
			await poll(`agent on port ${MOVED_PORT} with a renderer`, 60_000, async () => {
				const current = await status();
				return current.agent.port === MOVED_PORT && current.renderers.length > 0 ? true : null;
			}, 2_000);
			await poll("BetterGrokBot.bridgeState() === connected after the move", 60_000, async () =>
				(await page.evaluate("BetterGrokBot.bridgeState()")) === "connected" ? true : null,
			);
			check((await page.evaluate("window.__bgbE2eNoReload === 1")) === true, "the page reloaded during the port move");
			const config = await readConfigFile();
			check(config.port === MOVED_PORT && config.token === token, "config.json port/token after the move are wrong");
			const moved = await Bridge.connect(MOVED_PORT, token, { buildKey: "cli", appVersion, bgbVersion });
			bridges.push(moved);
			const watchFrom = moved.events.length;
			const result = await moved.request("keys.watch", { codes: ["AltRight"] });
			check(JSON.stringify(result) === JSON.stringify({ unsupported: [] }), `keys.watch on the new port returned ${JSON.stringify(result)}`);
			if (expectHelper) {
				const starting = await moved.waitForEvent("keys.state starting on the new port", 60_000, (e) => keysState(e) === "starting", watchFrom);
				await moved.waitForEvent("keys.state ready on the new port", 60_000, (e) => keysState(e) === "ready", starting.index + 1);
			}
			moved.close();
			if (expectHelper) {
				await poll("the idle helper to exit", 75_000, async () => ((await helperRunning()) ? null : true), 2_000);
			}
		}, { timeoutMs: 480_000 });

		await step("11 restart a running app", async () => {
			live.cdp?.close();
			live.cdp = null;
			await bgb(["restart", "--yes", "--force"], { timeoutMs: 120_000 });
			await poll("the restarted app with a renderer on the current build", 90_000, async () => {
				const current = await status();
				return current.app?.running === true && !!current.build && current.renderers.some((r) => r.buildKey === current.build?.key) ? true : null;
			}, 2_000);
		}, { timeoutMs: 300_000 });

		await step("12 uninstall", async () => {
			await quitApp();
			live.uninstalled = true;
			await bgb(["uninstall", "--purge", "--yes"], { timeoutMs: 120_000 });
			if (os === "darwin") {
				check((await launchctlGetenv()) === "", `launchctl still has ${HOOK_ENV}`);
				for (const label of [AGENT_LABEL, LOGIN_LABEL]) check(!existsSync(macPlist(label)), `${macPlist(label)} still exists`);
			} else if (os === "win32") {
				check((await windowsUserHookValue()) === "", `the User ${HOOK_ENV} is still set`);
				const runValue = await runPowerShell(
					"(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).BetterGrokBot",
				);
				check(runValue.trim() === "", "the BetterGrokBot Run value still exists");
			} else {
				if (existsSync(linuxHookFile)) check(!(await readFile(linuxHookFile, "utf8")).includes(LINUX_MARKER), `${linuxHookFile} is still hooked`);
				check(!existsSync(linuxAutostartFile), `${linuxAutostartFile} still exists`);
			}
			await Bun.sleep(10_000);
			const leftovers = (await processNames()).filter((name) => BGB_PROCESS.test(name) || HELPER_PROCESS.test(name));
			check(leftovers.length === 0, `still running: ${leftovers.join(", ")}`);
			check(!existsSync(paths.root), `${paths.root} still exists after --purge`);
		}, { timeoutMs: 300_000 });
	} finally {
		live.cdp?.close();
		for (const bridge of bridges) bridge.close();
		if (!live.uninstalled && existsSync(bin)) {
			log("cleaning up after an aborted run");
			const cleanup = (async () => {
				await quitApp().catch(() => {});
				await bgb(["uninstall", "--purge", "--yes"], { allowFail: true, timeoutMs: 120_000 }).catch(() => "");
			})();
			if ((await within(cleanup, 240_000)) === TIMED_OUT) log("cleanup did not finish within 240 s; giving up on it");
		}
		await rm(tmp, { recursive: true, force: true }).catch(() => {});
	}

	const result = { ok: failures.length === 0, failures };
	const out = path.resolve(`e2e-${feedPlatform}.json`);
	await writeFile(out, `${JSON.stringify(result, null, "\t")}\n`);
	console.log(JSON.stringify(result, null, "\t"));
	return result.ok ? 0 : 1;
});

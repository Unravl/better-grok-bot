/**
 * Native helper lifecycle (Step 4.5). macOS: the helper app runs under its own LaunchAgent (TCC
 * attributes Input Monitoring to it) and reconnects by itself. Windows/Linux: the helper is a child
 * of the agent, started on demand and stopped when idle.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Platform } from "../../sdk/index.ts";
import { errorMessage } from "../errors.ts";
import { renameReplacing } from "../json-file.ts";
import type { Logger } from "../log.ts";
import type { DataPaths } from "../paths.ts";
import { type FetchFn, fetchVerified } from "../update/download.ts";
import { type CommandRunner, mustRun } from "./command.ts";
import { type HelperAsset, type HelperManifest, helperAssetKey, helperDownloadUrl } from "./helper-manifest.ts";

/** LaunchAgent label and bundle id of the macOS helper. */
export const HELPER_LABEL = "io.github.unravl.bettergrokbot.helper";
export const HELPER_APP_NAME = "Better Grok Bot Helper.app";
const HELPER_EXECUTABLE = "bgb-helper";
const DOWNLOAD_LIMIT = { timeoutMs: 120_000, maxBytes: 100 * 1024 * 1024 };
const RESTART_MAX_MS = 30_000;
const QUIT_GRACE_MS = 5_000;
const STOP_GRACE_MS = 3_000;

export interface HelperProcess {
	readonly pid: number;
	readonly exited: Promise<number>;
	kill(): void;
}

export type HelperSpawner = (file: string, env: Record<string, string>, log: Logger) => HelperProcess;

async function logLines(stream: ReadableStream<Uint8Array>, write: (line: string) => void): Promise<void> {
	let buffer = "";
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) write(line);
	}
	if (buffer.trim()) write(buffer);
}

/** Spawns a Windows/Linux helper child, its stdout/stderr going to the agent log. */
export const spawnHelper: HelperSpawner = (file, env, log) => {
	const proc = Bun.spawn([file], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
	void logLines(proc.stdout, (line) => log.info(`helper: ${line}`)).catch(() => undefined);
	void logLines(proc.stderr, (line) => log.warn(`helper: ${line}`)).catch(() => undefined);
	return { pid: proc.pid, exited: proc.exited, kill: () => proc.kill() };
};

function xml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The helper's LaunchAgent plist (Step 4.5). */
export function helperPlist(opts: { executable: string; dataDir: string; logFile: string }): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${HELPER_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(opts.executable)}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>BGB_DATA_DIR</key>
		<string>${xml(opts.dataDir)}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>${xml(opts.logFile)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(opts.logFile)}</string>
</dict>
</plist>
`;
}

export interface HelperControllerOptions {
	paths: DataPaths;
	log: Logger;
	platform: Platform;
	arch: string;
	manifest: HelperManifest;
	/** `BGB_HELPER_PATH` (a local helper binary, `.app` or `.zip`) overrides the download; also the child's base env. */
	env: Record<string, string | undefined>;
	fetch: FetchFn;
	run: CommandRunner;
	spawn: HelperSpawner;
	/** macOS: `~/Library/LaunchAgents`. */
	launchAgentsDir: string;
	uid: number;
	/** The bridge the helper connects to. */
	endpoint(): { port: number; token: string };
	/** Sends `{type:"quit"}` to the connected helper; false when none is connected. */
	requestQuit(): boolean;
	onChange(): void;
	idleMs?: number;
	maxFailures?: number;
	/** First restart delay; doubles per unexpected exit up to 30 s. */
	restartBaseMs?: number;
}

export class HelperController {
	readonly maxFailures: number;
	private readonly opts: HelperControllerOptions;
	private readonly idleMs: number;
	private readonly restartBaseMs: number;
	private wanted = false;
	private stopped = false;
	private child: HelperProcess | null = null;
	private launching = false;
	private saidHello = false;
	private quitting = false;
	private failureCount = 0;
	private failureReason: string | null = null;
	private restartAttempts = 0;
	private restartTimer: Timer | null = null;
	private idleTimer: Timer | null = null;
	private killTimer: Timer | null = null;

	constructor(opts: HelperControllerOptions) {
		this.opts = opts;
		this.idleMs = opts.idleMs ?? 30_000;
		this.maxFailures = opts.maxFailures ?? 5;
		this.restartBaseMs = opts.restartBaseMs ?? 1_000;
	}

	/** Why no helper can run here (nothing published for this OS/arch), or `null`. */
	unavailableReason(): string | null {
		const { manifest, platform, arch, env } = this.opts;
		if (env.BGB_HELPER_PATH) return null;
		if (Object.keys(manifest.assets).length === 0) return "no native helper has been published yet";
		const key = helperAssetKey(platform, arch);
		return key && manifest.assets[key] ? null : `no native helper is published for ${platform}-${arch}`;
	}

	/** Consecutive starts that ended before the helper said hello. */
	get failures(): number {
		return this.failureCount;
	}

	get lastFailure(): string | null {
		return this.failureReason;
	}

	/** Windows/Linux: a child is being downloaded/started or a restart is scheduled, and it has not said hello. */
	get starting(): boolean {
		return !this.saidHello && (this.launching || this.child !== null || this.restartTimer !== null);
	}

	get running(): boolean {
		return this.child !== null;
	}

	private get versionFile(): string {
		return path.join(this.opts.paths.helpers, "version.txt");
	}

	private get plistPath(): string {
		return path.join(this.opts.launchAgentsDir, `${HELPER_LABEL}.plist`);
	}

	private get macExecutable(): string {
		return path.join(this.opts.paths.helpers, HELPER_APP_NAME, "Contents", "MacOS", HELPER_EXECUTABLE);
	}

	/** macOS: the helper app and its LaunchAgent plist both exist. */
	isInstalled(): boolean {
		return existsSync(this.plistPath) && existsSync(this.macExecutable);
	}

	private async installedVersion(): Promise<string | null> {
		return (await readFile(this.versionFile, "utf8").catch(() => null))?.trim() ?? null;
	}

	/**
	 * macOS: true when an installed helper came from another `helper-manifest.json` version. Helper
	 * bytes (and with them TCC grants) change only then, never on a plain BGB update.
	 */
	async needsReinstall(): Promise<boolean> {
		if (this.opts.env.BGB_HELPER_PATH || !this.isInstalled() || this.unavailableReason() !== null) return false;
		return (await this.installedVersion()) !== String(this.opts.manifest.version);
	}

	private asset(): HelperAsset {
		const key = helperAssetKey(this.opts.platform, this.opts.arch);
		const asset = key ? this.opts.manifest.assets[key] : undefined;
		if (!asset) throw new Error(this.unavailableReason() ?? "no native helper is published for this system");
		return asset;
	}

	private async download(): Promise<{ bytes: Uint8Array; asset: HelperAsset }> {
		const asset = this.asset();
		const url = helperDownloadUrl(this.opts.manifest, asset);
		return { bytes: await fetchVerified(this.opts.fetch, url, asset.sha256, DOWNLOAD_LIMIT), asset };
	}

	/**
	 * macOS: installs the helper app into `DATA/helpers/` and loads its LaunchAgent. Windows/Linux:
	 * downloads the helper if missing and starts it (it quits again after the idle period).
	 */
	async install(): Promise<void> {
		if (this.opts.platform === "darwin") {
			await this.installMac();
			return;
		}
		await this.ensureBinary();
		this.failureCount = 0;
		this.failureReason = null;
		await this.ensureRunning();
		this.armIdle();
	}

	private async installMac(): Promise<void> {
		const { paths, run, uid, env, manifest } = this.opts;
		const app = path.join(paths.helpers, HELPER_APP_NAME);
		const override = env.BGB_HELPER_PATH;
		// Download first, so a failed download leaves the installed helper running.
		const download = override ? undefined : await this.download();
		await mkdir(paths.helpers, { recursive: true });
		await run(["launchctl", "bootout", `gui/${uid}/${HELPER_LABEL}`]);
		try {
			await rm(app, { recursive: true, force: true });
			if (override && !override.endsWith(".zip")) {
				await mustRun(run, ["ditto", override, app]);
			} else {
				let zip = override ?? "";
				if (download) {
					await mkdir(paths.cache, { recursive: true });
					zip = path.join(paths.cache, `helper-${randomBytes(6).toString("hex")}.zip`);
					await writeFile(zip, download.bytes);
				}
				try {
					await mustRun(run, ["ditto", "-x", "-k", zip, paths.helpers]);
				} finally {
					if (download) await rm(zip, { force: true });
				}
			}
			if (!existsSync(this.macExecutable)) throw new Error(`${app} has no Contents/MacOS/${HELPER_EXECUTABLE}`);
			await writeFile(this.versionFile, override ? "dev\n" : `${manifest.version}\n`);
			await mkdir(this.opts.launchAgentsDir, { recursive: true });
			await writeFile(
				this.plistPath,
				helperPlist({ executable: this.macExecutable, dataDir: paths.root, logFile: path.join(paths.logs, "helper.log") }),
			);
			await mustRun(run, ["launchctl", "bootstrap", `gui/${uid}`, this.plistPath]);
		} catch (error) {
			await this.removeMacInstall(app);
			throw error;
		}
		this.opts.log.info(override ? `installed helper from ${override}` : `installed helper ${manifest.tag}`);
	}

	/**
	 * macOS: removes a partial install (the old helper is already booted out), so it is neither reported
	 * installed nor loaded by launchd at the next login. The version marker goes first: should a later
	 * removal fail, the leftover app/plist still counts as another version and is reinstalled.
	 */
	private async removeMacInstall(app: string): Promise<void> {
		for (const file of [this.versionFile, this.plistPath, app]) {
			await rm(file, { recursive: true, force: true }).catch((error: unknown) => {
				this.opts.log.warn(`cannot remove ${file} after a failed helper install: ${errorMessage(error)}`);
			});
		}
	}

	/** Windows/Linux: the helper binary, downloaded when missing or from another manifest version. */
	private async ensureBinary(): Promise<string> {
		const { paths, platform, env, manifest, log } = this.opts;
		if (env.BGB_HELPER_PATH) return env.BGB_HELPER_PATH;
		const file = path.join(paths.helpers, platform === "win32" ? "bgb-helper.exe" : "bgb-helper");
		if (existsSync(file) && (await this.installedVersion()) === String(manifest.version)) return file;
		const { bytes, asset } = await this.download();
		await mkdir(paths.helpers, { recursive: true });
		const temp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
		try {
			await writeFile(temp, bytes, { mode: 0o755 });
			await renameReplacing(temp, file);
		} catch (error) {
			await rm(temp, { force: true });
			throw error;
		}
		await writeFile(this.versionFile, `${manifest.version}\n`);
		log.info(`installed helper ${manifest.tag} (${asset.name})`);
		return file;
	}

	/** Windows/Linux: whether any connection needs the helper; starts it, or quits it after the idle period. */
	setWanted(wanted: boolean): void {
		if (this.opts.platform === "darwin" || this.stopped) return;
		const was = this.wanted;
		this.wanted = wanted;
		if (wanted) {
			this.clearIdle();
			// A new request after giving up retries from scratch.
			if (!was && this.failureCount >= this.maxFailures) {
				this.failureCount = 0;
				this.failureReason = null;
			}
			void this.ensureRunning();
		} else if (was) {
			this.clearRestart();
			this.armIdle();
		}
	}

	/** Windows/Linux: starts the helper unless it runs, is starting, or failed {@link maxFailures} times in a row. */
	async ensureRunning(): Promise<void> {
		if (this.stopped || this.child || this.launching || this.failureCount >= this.maxFailures) return;
		this.clearRestart();
		this.launching = true;
		this.opts.onChange();
		try {
			const file = await this.ensureBinary();
			if (this.stopped) return;
			const { port, token } = this.opts.endpoint();
			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(this.opts.env)) if (value !== undefined) env[key] = value;
			env.BGB_BRIDGE_URL = `ws://127.0.0.1:${port}/helper`;
			env.BGB_HELPER_TOKEN = token;
			const child = this.opts.spawn(file, env, this.opts.log);
			this.child = child;
			this.saidHello = false;
			this.opts.log.info(`helper started (pid ${child.pid})`);
			void child.exited.then(
				(code) => this.exited(child, code),
				() => this.exited(child, -1),
			);
		} catch (error) {
			this.fail(`helper failed to start: ${errorMessage(error)}`);
		} finally {
			this.launching = false;
			this.opts.onChange();
		}
	}

	/** The helper said hello: it started successfully. */
	helloReceived(): void {
		this.saidHello = true;
		this.failureCount = 0;
		this.failureReason = null;
		this.restartAttempts = 0;
		this.opts.onChange();
	}

	/** Windows/Linux: quits a running helper after the idle period unless it is wanted again. */
	armIdle(): void {
		this.clearIdle();
		if (this.wanted || this.stopped) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			if (!this.wanted) this.quit();
		}, this.idleMs);
	}

	/** Agent shutdown: asks a running child to quit (killing one that never connected), waits briefly, then kills it. */
	async stop(): Promise<void> {
		this.stopped = true;
		this.clearIdle();
		this.clearRestart();
		this.clearKill();
		const child = this.child;
		if (!child) return;
		this.quitting = true;
		if (!this.opts.requestQuit()) child.kill();
		const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
		if (!exited) child.kill();
	}

	private quit(): void {
		this.clearRestart();
		const child = this.child;
		if (!child) return;
		this.quitting = true;
		this.opts.log.info("helper idle; asking it to quit");
		if (!this.opts.requestQuit()) child.kill();
		this.clearKill();
		this.killTimer = setTimeout(() => {
			this.killTimer = null;
			if (this.child === child) child.kill();
		}, QUIT_GRACE_MS);
	}

	private exited(child: HelperProcess, code: number): void {
		if (this.child !== child) return;
		this.child = null;
		this.clearKill();
		const expected = this.quitting || this.stopped;
		const hadHello = this.saidHello;
		this.quitting = false;
		this.saidHello = false;
		if (expected) {
			this.opts.log.info(`helper exited (code ${code})`);
		} else if (hadHello) {
			this.opts.log.warn(`helper exited unexpectedly with code ${code}`);
			this.scheduleRestart();
		} else {
			this.fail(`helper exited with code ${code} before connecting`);
		}
		this.opts.onChange();
	}

	private fail(reason: string): void {
		this.failureCount++;
		this.failureReason = reason;
		this.opts.log.warn(`${reason} (${this.failureCount} in a row)`);
		this.scheduleRestart();
	}

	private scheduleRestart(): void {
		if (!this.wanted || this.stopped || this.failureCount >= this.maxFailures || this.restartTimer) return;
		const delay = Math.min(this.restartBaseMs * 2 ** this.restartAttempts, RESTART_MAX_MS);
		this.restartAttempts++;
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			void this.ensureRunning();
		}, delay);
	}

	private clearRestart(): void {
		clearTimeout(this.restartTimer ?? undefined);
		this.restartTimer = null;
	}

	private clearIdle(): void {
		clearTimeout(this.idleTimer ?? undefined);
		this.idleTimer = null;
	}

	private clearKill(): void {
		clearTimeout(this.killTimer ?? undefined);
		this.killTimer = null;
	}
}

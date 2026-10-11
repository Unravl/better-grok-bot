/**
 * Agent-side `keys` and `media` services: per-connection requests from renderers, the native helper
 * connection, and the state each service reports (Steps 4.5–4.7).
 */
import { homedir } from "node:os";
import * as path from "node:path";
import {
	type AgentToHelper,
	type BridgeEvent,
	type BridgeEvents,
	HELPER_CODES,
	type HelperToAgent,
	type KeysState,
	type MediaState,
	type Platform,
	type ServiceStateInfo,
} from "../../sdk/index.ts";
import { BgbError, errorMessage } from "../errors.ts";
import type { Logger } from "../log.ts";
import type { DataPaths } from "../paths.ts";
import type { FetchFn } from "../update/download.ts";
import { type CommandRunner, runCommand } from "./command.ts";
import { HelperController, type HelperSpawner, spawnHelper } from "./helper.ts";
import { HELPER_MANIFEST, type HelperManifest } from "./helper-manifest.ts";
import { KeyWatches, computeKeysState, parseWatchCodes } from "./keys.ts";
import { DuckLevels, computeMediaState, duckFrame, parseDuckLevel } from "./media.ts";
import { LinuxDucker } from "./media-linux.ts";

export interface ServiceSnapshot {
	keys: ServiceStateInfo<KeysState>;
	media: ServiceStateInfo<MediaState>;
}

/** How services reach renderers and the helper (the bridge, in the agent). */
export interface ServicesHost {
	sendEvent<E extends BridgeEvent>(connectionId: number, event: E, data: BridgeEvents[E]): void;
	broadcast<E extends BridgeEvent>(event: E, data: BridgeEvents[E]): void;
	sendHelper(connectionId: number, message: AgentToHelper): void;
	/** The bridge a helper child connects to. */
	endpoint(): { port: number; token: string };
}

export interface ServicesOptions {
	paths: DataPaths;
	log: Logger;
	platform: Platform;
	host: ServicesHost;
	arch?: string;
	env?: Record<string, string | undefined>;
	manifest?: HelperManifest;
	fetch?: FetchFn;
	run?: CommandRunner;
	spawn?: HelperSpawner;
	/** macOS helper LaunchAgent dir; default `~/Library/LaunchAgents`. */
	launchAgentsDir?: string;
	uid?: number;
	idleMs?: number;
	/** First helper restart delay (doubles up to 30 s). */
	restartBaseMs?: number;
	/** Linux ducker; default one over `run`. */
	linuxDucker?: LinuxDucker;
	/** Called after any service state change (persist + `status.changed`). */
	onChange?(snapshot: ServiceSnapshot): void;
}

type HelperHello = Extract<HelperToAgent, { type: "hello" }>;

function keysUnsupportedReason(platform: Platform, env: Record<string, string | undefined>): string | null {
	if (platform !== "linux") return null;
	if (env.XDG_SESSION_TYPE === "wayland") return "background keys need an X11 session; Wayland is not supported";
	if (!env.DISPLAY) return "background keys need an X11 display (DISPLAY is not set)";
	return null;
}

function sameInfo<S extends string>(a: ServiceStateInfo<S>, b: ServiceStateInfo<S>): boolean {
	return a.state === b.state && a.detail === b.detail;
}

export class Services {
	private readonly opts: ServicesOptions;
	private readonly platform: Platform;
	private readonly controller: HelperController;
	private readonly keys = new KeyWatches();
	private readonly ducks = new DuckLevels();
	private readonly linux: LinuxDucker | null;
	private readonly keysUnsupported: string | null;
	private readonly helperUnavailable: string | null;
	private linuxState: ServiceStateInfo<MediaState> = { state: "unsupported", detail: "pactl not probed yet" };
	private helperId: number | null = null;
	private hello: HelperHello | null = null;
	private helperLost = false;
	private installing = false;
	private installed = false;
	private installError: string | null = null;
	private last: ServiceSnapshot;

	constructor(opts: ServicesOptions) {
		this.opts = opts;
		this.platform = opts.platform;
		const env = opts.env ?? process.env;
		const run = opts.run ?? runCommand;
		this.controller = new HelperController({
			paths: opts.paths,
			log: opts.log,
			platform: opts.platform,
			arch: opts.arch ?? process.arch,
			manifest: opts.manifest ?? HELPER_MANIFEST,
			env,
			fetch: opts.fetch ?? fetch,
			run,
			spawn: opts.spawn ?? spawnHelper,
			launchAgentsDir: opts.launchAgentsDir ?? path.join(homedir(), "Library", "LaunchAgents"),
			uid: opts.uid ?? process.getuid?.() ?? 0,
			endpoint: () => opts.host.endpoint(),
			requestQuit: () => this.send({ type: "quit" }),
			onChange: () => this.recompute(),
			idleMs: opts.idleMs,
			restartBaseMs: opts.restartBaseMs,
		});
		this.helperUnavailable = this.controller.unavailableReason();
		this.keysUnsupported = keysUnsupportedReason(opts.platform, env) ?? this.helperUnavailable;
		this.linux = opts.platform === "linux" ? (opts.linuxDucker ?? new LinuxDucker({ run, log: opts.log })) : null;
		this.last = this.compute();
	}

	/** Probes `pactl` (Linux) and the installed helper (macOS; reinstalls one from another manifest version). */
	async start(): Promise<void> {
		if (this.linux) this.linuxState = await this.linux.probe();
		if (this.platform === "darwin") {
			this.installed = this.controller.isInstalled();
			if (await this.controller.needsReinstall()) void this.runInstall().catch(() => undefined);
		}
		this.recompute();
	}

	snapshot(): ServiceSnapshot {
		return { keys: this.last.keys, media: this.last.media };
	}

	/** `keys.watch`: replaces this connection's watched set. */
	watchKeys(connectionId: number, rawCodes: unknown): { unsupported: string[] } {
		const codes = parseWatchCodes(rawCodes);
		const available = this.availableCodes();
		const unsupported = codes.filter((code) => !available.has(code));
		if (this.keys.set(connectionId, codes.filter((code) => available.has(code)))) {
			this.sendWatch();
			this.updateWanted();
		}
		this.recompute();
		return { unsupported };
	}

	/** `media.duck`: this connection's level; the effective level is the minimum across connections. */
	duck(connectionId: number, rawLevel: unknown): void {
		if (!this.ducks.set(connectionId, parseDuckLevel(rawLevel))) return;
		this.applyDuck();
		this.updateWanted();
	}

	/** `keys.install`: installs (macOS) or downloads and starts (Windows/Linux) the helper serving keys and media. */
	async install(): Promise<void> {
		// On Linux without X11 the helper serves nothing (ducking runs in the agent over pactl).
		if (this.keysUnsupported !== null) throw new BgbError("unavailable", this.keysUnsupported);
		await this.runInstall();
	}

	private async runInstall(): Promise<void> {
		this.installing = this.platform === "darwin";
		this.recompute();
		try {
			await this.controller.install();
			this.installError = null;
			if (this.platform === "darwin") {
				this.installed = true;
				this.helperLost = false;
			}
		} catch (error) {
			const message = errorMessage(error);
			this.opts.log.error(`helper install failed: ${message}`);
			this.installError = message;
			if (this.platform === "darwin") this.installed = this.controller.isInstalled();
			throw new BgbError("internal", `helper install failed: ${message}`);
		} finally {
			this.installing = false;
			this.recompute();
		}
	}

	rendererClosed(connectionId: number): void {
		const keysChanged = this.keys.drop(connectionId);
		const duckChanged = this.ducks.drop(connectionId);
		if (keysChanged) this.sendWatch();
		if (duckChanged) this.applyDuck();
		if (keysChanged || duckChanged) this.updateWanted();
		this.recompute();
	}

	/** A helper connected; returns the id of a previous helper connection the caller should close. */
	helperOpened(connectionId: number): number | null {
		const previous = this.helperId;
		this.helperId = connectionId;
		this.hello = null;
		if (previous !== null) this.releaseDown();
		this.recompute();
		return previous;
	}

	helperMessage(connectionId: number, message: HelperToAgent): void {
		if (connectionId !== this.helperId) return;
		switch (message.type) {
			case "hello":
				this.hello = message;
				this.helperLost = false;
				this.opts.log.info(`helper connected (keys ${message.keys}, media ${message.media})`);
				this.controller.helloReceived();
				this.sendWatch();
				this.sendDuck();
				break;
			case "access":
				if (!this.hello) return;
				this.hello = {
					...this.hello,
					keys: message.keys,
					codes:
						message.keys === "granted" && this.hello.codes.length === 0 ? [...HELPER_CODES[this.platform]] : this.hello.codes,
				};
				this.sendWatch();
				break;
			case "key":
				if (!this.hello) return;
				for (const id of this.keys.key(message.code, message.down)) {
					this.opts.host.sendEvent(id, "keys.key", { code: message.code, down: message.down });
				}
				return;
			case "chord":
				for (const id of this.keys.watchers(message.code)) this.opts.host.sendEvent(id, "keys.chord", { code: message.code });
				return;
			case "log":
				this.opts.log[message.level](`helper: ${message.message}`);
				return;
		}
		this.recompute();
	}

	helperClosed(connectionId: number): void {
		if (connectionId !== this.helperId) return;
		this.helperId = null;
		this.hello = null;
		this.releaseDown();
		if (this.platform === "darwin") this.helperLost = true;
		this.recompute();
	}

	/**
	 * Agent shutdown: restores every duck and empties the helper's watch set; the controller then quits
	 * a Windows/Linux child (the macOS helper stays up under launchd and reconnects).
	 */
	async shutdown(): Promise<void> {
		if (this.linux) await this.linux.restoreNow();
		this.send(duckFrame(1));
		this.send({ type: "watch", codes: [] });
		await this.controller.stop();
	}

	private send(message: AgentToHelper): boolean {
		if (this.helperId === null) return false;
		this.opts.host.sendHelper(this.helperId, message);
		return true;
	}

	private availableCodes(): ReadonlySet<string> {
		if (this.keysUnsupported !== null) return new Set();
		if (this.hello) return new Set(this.hello.keys === "unsupported" ? [] : this.hello.codes);
		return new Set(HELPER_CODES[this.platform]);
	}

	private sendWatch(): void {
		const hello = this.hello;
		if (!hello) return;
		this.send({ type: "watch", codes: this.keys.union().filter((code) => hello.codes.includes(code)) });
	}

	private sendDuck(): void {
		if (this.platform !== "linux" && this.hello) this.send(duckFrame(this.ducks.effective()));
	}

	/** Delivers the effective level: to the Linux ducker, else to the connected helper. */
	private applyDuck(): void {
		const level = this.ducks.effective();
		if (!this.linux) this.sendDuck();
		else if (this.linuxState.state === "ready") void this.linux.request(level < 1 ? level : null);
	}

	/** Windows/Linux: the helper child runs while someone watches a key or (Windows) ducks. */
	private updateWanted(): void {
		if (this.platform === "darwin" || this.helperUnavailable !== null) return;
		const ducking = this.platform === "win32" && this.ducks.effective() < 1;
		this.controller.setWanted(this.keys.union().length > 0 || ducking);
	}

	private releaseDown(): void {
		for (const { code, connections } of this.keys.releaseAll()) {
			for (const id of connections) this.opts.host.sendEvent(id, "keys.key", { code, down: false });
		}
	}

	private compute(): ServiceSnapshot {
		const common = {
			platform: this.platform,
			failures: this.controller.failures,
			maxFailures: this.controller.maxFailures,
			lastFailure: this.controller.lastFailure,
			installed: this.installed,
		};
		return {
			keys: computeKeysState({
				...common,
				unsupportedReason: this.keysUnsupported,
				installing: this.installing,
				installError: this.installError,
				access: this.hello?.keys ?? null,
				helperLost: this.helperLost,
				starting: this.controller.starting,
			}),
			media: computeMediaState({
				...common,
				unsupportedReason: this.helperUnavailable,
				helperMedia: this.hello?.media ?? null,
				linux: this.linuxState,
			}),
		};
	}

	private recompute(): void {
		const next = this.compute();
		const keysChanged = !sameInfo(next.keys, this.last.keys);
		const mediaChanged = !sameInfo(next.media, this.last.media);
		this.last = next;
		if (keysChanged) this.opts.host.broadcast("keys.state", next.keys);
		if (mediaChanged) this.opts.host.broadcast("media.state", next.media);
		if (keysChanged || mediaChanged) this.opts.onChange?.(this.snapshot());
	}
}

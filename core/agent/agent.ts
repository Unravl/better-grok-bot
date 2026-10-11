/**
 * The long-running agent (Step 4.3): owns the bridge, services, builds, watchers and self-update for
 * one `DATA` directory while it holds the singleton record.
 */
import { type FSWatcher, watch } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { type AgentStatus, RENDERER_URL_ENV, type UpdateStatus } from "../../sdk/index.ts";
import { createMethodHandlers } from "../bridge/methods.ts";
import { type Bridge, startBridge } from "../bridge/server.ts";
import { type Config, readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { BgbError, errorMessage } from "../errors.ts";
import { rendererUrl } from "../paths.ts";
import { type AppInstall, HookConflictError } from "../platform/types.ts";
import type { CommandRunner } from "../services/command.ts";
import { Services, type ServicesOptions } from "../services/index.ts";
import { McpServers } from "../services/mcp.ts";
import { type State, mutateState, readState } from "../state.ts";
import { type UpdateDeps, applyUpdate, checkForUpdate, compareVersions } from "../update/self-update.ts";
import { BGB_COMPILED, BGB_VERSION } from "../version.ts";
import { type BuildResult, BuildScheduler } from "./builder.ts";
import type { CoreOps } from "./ops.ts";
import { type DataChange, type DataWatcher, watchApp, watchData } from "./watch.ts";

export interface AgentDeps {
	ops: CoreOps;
	run: CommandRunner;
	/** Restart rule outside launchd: start `bgb agent --replace` after this agent has shut down. */
	respawn(ctx: CoreContext): void | Promise<void>;
	underLaunchd: boolean;
	/** Overrides for the keys/media services (helper download, spawner, LaunchAgents dir, …). */
	services: Partial<Omit<ServicesOptions, "paths" | "log" | "platform" | "host" | "onChange">>;
	update: Partial<UpdateDeps>;
	appPollMs: number;
	updateIntervalMs: number;
	dataDebounceMs: number;
	handleSignals: boolean;
}

/** Builds the `EADDRINUSE` message, naming another BGB agent when `/health` identifies one. */
async function bindFailureMessage(port: number, error: unknown): Promise<string> {
	const message = errorMessage(error);
	const code = error instanceof Error && "code" in error ? error.code : undefined;
	if (code !== "EADDRINUSE" && !/EADDRINUSE|in use/i.test(message)) return `cannot listen on port ${port}: ${message}`;
	const hint = "run: bgb config set bridgePort <free port>";
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
		const body: unknown = await response.json();
		if (typeof body === "object" && body !== null && "name" in body && body.name === "better-grok-bot") {
			const pid = "pid" in body ? String(body.pid) : "?";
			return `port ${port} is in use by the Better Grok Bot agent of another data directory (pid ${pid}); ${hint}`;
		}
	} catch {
		// Not an HTTP server we know.
	}
	return `port ${port} is in use by another program; ${hint}`;
}

function initialUpdateStatus(state: State, compiled: boolean): UpdateStatus {
	if (!compiled) return { state: "disabled", current: BGB_VERSION };
	const latest = state.update.latest ?? undefined;
	if (state.update.error) return { state: "error", current: BGB_VERSION, latest, error: state.update.error };
	if (latest && compareVersions(latest, BGB_VERSION) > 0) return { state: "available", current: BGB_VERSION, latest };
	return { state: "idle", current: BGB_VERSION, latest };
}

export class Agent {
	private readonly ctx: CoreContext;
	private readonly deps: AgentDeps;
	private readonly release: () => Promise<void>;
	private readonly scheduler: BuildScheduler;
	private readonly services: Services;
	private readonly mcp: McpServers;
	private readonly done = Promise.withResolvers<number>();
	private readonly notified = new Set<string>();
	private config: Config;
	private bridge: Bridge | null = null;
	private app: AppInstall | null = null;
	private currentBuildKey: string | null = null;
	private building = false;
	private updateStatus: UpdateStatus = { state: "disabled", current: BGB_VERSION };
	private stopAppWatch: (() => void) | null = null;
	private dataWatcher: DataWatcher | null = null;
	private hookWatcher: FSWatcher | null = null;
	private hookDebounce: Timer | undefined;
	private updateTimer: Timer | undefined;
	private statusTimer: Timer | undefined;
	private serialQueue: Promise<void> = Promise.resolve();
	private stateWrites: Promise<void> = Promise.resolve();
	private persistQueued = false;
	private appMissingLogged = false;
	private stopping: Promise<void> | null = null;
	/** The running (or completed and restarting) self-update; see {@link installUpdate}. */
	private updateInFlight: Promise<boolean> | null = null;
	private readonly onSignal = (): void => void this.stop(false);

	constructor(ctx: CoreContext, deps: AgentDeps, config: Config, release: () => Promise<void>) {
		this.ctx = ctx;
		this.deps = deps;
		this.config = config;
		this.release = release;
		this.scheduler = new BuildScheduler((force) => this.buildOnce(force));
		this.mcp = new McpServers(ctx);
		this.services = new Services({
			...deps.services,
			paths: ctx.paths,
			log: ctx.log,
			platform: ctx.platform.id,
			run: deps.services.run ?? deps.run,
			host: {
				sendEvent: (id, event, data) => void this.bridge?.send(id, event, data),
				broadcast: (event, data) => this.bridge?.broadcast(event, data),
				sendHelper: (id, message) => void this.bridge?.sendHelper(id, message),
				endpoint: () => ({ port: this.bridge?.port ?? this.config.bridgePort, token: this.config.bridgeToken }),
			},
			onChange: () => {
				this.persistLive();
				this.scheduleStatus();
			},
		});
	}

	/** Resolves with the exit code once the agent has shut down (and, for a restart, respawned). */
	get finished(): Promise<number> {
		return this.done.promise;
	}

	/** Binds the bridge and starts every subsystem; throws a user-facing message when the port is taken. */
	async start(): Promise<void> {
		const { ctx, deps } = this;
		await this.services.start();
		try {
			this.bridge = startBridge({
				port: this.config.bridgePort,
				token: this.config.bridgeToken,
				log: ctx.log,
				handlers: createMethodHandlers({
					ctx,
					ops: deps.ops,
					status: () => this.status(),
					configChanged: (config) => this.serial(() => this.applyConfig(config)),
					pluginsChanged: () => void this.scheduler.request(),
					rebuild: (force) => void this.scheduler.request(force),
					services: this.services,
					sidebar: {
						renderers: () => {
							const bridge = this.bridge;
							if (!bridge || this.stopping) throw new BgbError("unavailable", "The sidebar bridge is not available");
							return bridge.renderers();
						},
						requestSidebar: (connectionId, command) => {
							const bridge = this.bridge;
							if (!bridge || this.stopping) throw new BgbError("unavailable", "The sidebar bridge is not available");
							return bridge.requestSidebar(connectionId, command);
						},
					},
					mcp: this.mcp,
					checkUpdate: () => this.checkUpdate(),
					applyUpdate: () => this.installUpdate(),
				}),
				currentBuildKey: () => this.currentBuildKey,
				onRendererOpen: () => this.persistLive(),
				onRendererClose: (connection) => {
					this.services.rendererClosed(connection.id);
					this.persistLive();
				},
				onHelperOpen: (connection) => {
					const previous = this.services.helperOpened(connection.id);
					if (previous !== null) this.bridge?.closeHelper(previous);
				},
				onHelperMessage: (connection, message) => this.services.helperMessage(connection.id, message),
				onHelperClose: (connection) => this.services.helperClosed(connection.id),
				onShutdownRequest: () => void this.stop(false),
			});
		} catch (error) {
			throw new Error(await bindFailureMessage(this.config.bridgePort, error));
		}

		const state = await mutateState(ctx.paths, (draft) => {
			draft.renderers = [];
			draft.services = this.services.snapshot();
			if (draft.update.pending?.version === BGB_VERSION) draft.update.pending = null;
		});
		this.currentBuildKey = state.lastBuild?.key ?? null;
		this.updateStatus = initialUpdateStatus(state, deps.update.compiled ?? BGB_COMPILED);
		await this.removeTrash();
		await this.reexportHook(state);

		void this.scheduler.request();
		this.stopAppWatch = watchApp(
			() => deps.ops.resolveApp(ctx, this.config.appPath),
			() => void this.scheduler.request(),
			deps.appPollMs,
			{ log: ctx.log },
		);
		const devDirs = await deps.ops.readDevDirs(ctx).catch((error) => {
			ctx.log.warn(`dev plugins: ${errorMessage(error)}`);
			return [];
		});
		this.dataWatcher = await watchData(ctx.paths, (changes) => void this.serial(() => this.onDataChange(changes)), {
			debounceMs: deps.dataDebounceMs,
			devDirs,
			log: ctx.log,
		});
		this.watchLinuxHook(state);
		if (this.updateStatus.state !== "disabled") {
			void this.updateTick();
			this.updateTimer = setInterval(() => void this.updateTick(), deps.updateIntervalMs);
		}
		if (deps.handleSignals) {
			process.on("SIGTERM", this.onSignal);
			process.on("SIGINT", this.onSignal);
		}
		ctx.log.info(`agent ${BGB_VERSION} listening on 127.0.0.1:${this.bridge.port} (pid ${process.pid})`);
	}

	/** Graceful shutdown; with `restart`, then the restart rule (launchd's `KeepAlive`, or `agent --replace`). */
	async stop(restart: boolean): Promise<void> {
		const first = this.stopping === null;
		this.stopping ??= this.shutdown();
		await this.stopping;
		if (!first) return;
		if (restart && !this.deps.underLaunchd) {
			try {
				await this.deps.respawn(this.ctx);
			} catch (error) {
				this.ctx.log.error(`cannot start the replacement agent: ${errorMessage(error)}`);
			}
		}
		this.done.resolve(0);
	}

	private async shutdown(): Promise<void> {
		const { ctx } = this;
		ctx.log.info("agent stopping");
		process.off("SIGTERM", this.onSignal);
		process.off("SIGINT", this.onSignal);
		clearInterval(this.updateTimer);
		clearTimeout(this.statusTimer);
		clearTimeout(this.hookDebounce);
		this.stopAppWatch?.();
		this.dataWatcher?.close();
		this.hookWatcher?.close();
		this.scheduler.stop();
		await this.mcp.shutdown();
		await Promise.race([this.scheduler.idle(), Bun.sleep(10_000)]);
		await this.services.shutdown().catch((error) => ctx.log.error(`services shutdown: ${errorMessage(error)}`));
		await this.bridge?.stop();
		await this.stateWrites;
		await mutateState(ctx.paths, (draft) => {
			draft.renderers = [];
			draft.services = null;
		}).catch((error) => ctx.log.error(`state: ${errorMessage(error)}`));
		await this.release();
		ctx.log.info("agent stopped");
	}

	/** Runs `fn` after every earlier config/data reaction, so diffs never interleave. */
	private serial(fn: () => Promise<void>): Promise<void> {
		const next = this.serialQueue.then(fn);
		this.serialQueue = next.catch((error) => this.ctx.log.error(`agent: ${errorMessage(error)}`));
		return next;
	}

	private async onDataChange(changes: ReadonlySet<DataChange>): Promise<void> {
		if (this.stopping) return;
		const { ctx, deps } = this;
		if (changes.has("config")) {
			try {
				await this.applyConfig(await readConfig(ctx.paths));
			} catch (error) {
				ctx.log.warn(`config.json: ${errorMessage(error)}; keeping the previous settings`);
			}
			if (this.stopping) return;
		}
		const devList = changes.has("devList");
		if (devList) {
			const dirs = await deps.ops.readDevDirs(ctx).catch(() => []);
			this.dataWatcher?.setDevDirs(dirs);
		}
		const dev = devList || changes.has("dev");
		if (changes.has("themes")) await this.broadcastThemes();
		if (changes.has("themes") || changes.has("plugins") || dev) {
			const result = this.scheduler.request();
			if (dev) void result.then((outcome) => outcome.ok && this.bridge?.broadcast("dev.reload", {}));
		}
	}

	/** Reacts to a new config: port/token → rebuild + move; themes → `themes.changed` + rebuild; plugin inputs → rebuild. */
	private async applyConfig(next: Config): Promise<void> {
		const previous = this.config;
		if (JSON.stringify(previous) === JSON.stringify(next)) return;
		this.config = next;
		if (previous.bridgePort !== next.bridgePort || previous.bridgeToken !== next.bridgeToken) {
			await this.moveBridge(previous, next);
			return;
		}
		const themes = JSON.stringify(previous.enabledThemes) !== JSON.stringify(next.enabledThemes);
		const plugins =
			JSON.stringify(previous.disabledPlugins) !== JSON.stringify(next.disabledPlugins) ||
			JSON.stringify(previous.grants) !== JSON.stringify(next.grants) ||
			previous.appPath !== next.appPath;
		if (themes) await this.broadcastThemes();
		if (themes || plugins) void this.scheduler.request();
		if (!previous.autoUpdate && next.autoUpdate && this.updateStatus.state === "available") void this.updateTick();
		this.scheduleStatus();
	}

	/**
	 * A new `bridgePort` (or token): rebuild so boot payloads carry it, tell renderers where to reconnect,
	 * then restart onto it. Helper children restart with the new agent; the macOS helper rereads config.
	 */
	private async moveBridge(previous: Config, next: Config): Promise<void> {
		this.ctx.log.info(
			previous.bridgePort !== next.bridgePort
				? `bridgePort changed ${previous.bridgePort} → ${next.bridgePort}; moving`
				: "bridge token changed; restarting",
		);
		await this.scheduler.request();
		if (previous.bridgePort !== next.bridgePort) this.bridge?.broadcast("bridge.moving", { port: next.bridgePort });
		void this.stop(true);
	}

	private async broadcastThemes(): Promise<void> {
		try {
			const styles = await this.deps.ops.themeStyles(this.ctx, this.config);
			this.bridge?.broadcast("themes.changed", { styles });
		} catch (error) {
			this.ctx.log.warn(`themes: ${errorMessage(error)}`);
		}
	}

	private rendererKeys(): string[] {
		return (this.bridge?.renderers() ?? []).filter((r) => r.buildKey !== "cli").map((r) => r.buildKey);
	}

	private async buildOnce(force: boolean): Promise<BuildResult> {
		const { ctx, deps } = this;
		this.building = true;
		this.bridge?.broadcast("build.started", {});
		this.scheduleStatus();
		try {
			let app: AppInstall;
			try {
				app = await deps.ops.resolveApp(ctx, this.config.appPath);
			} catch (error) {
				const message = errorMessage(error);
				if (!this.appMissingLogged) ctx.log.warn(`Grok Bot not found (${message}); building once it appears`);
				this.appMissingLogged = true;
				this.bridge?.broadcast("build.finished", { buildKey: this.currentBuildKey ?? "", ok: false, appVersion: "", failed: [] });
				return { ok: false, error: message };
			}
			this.app = app;
			this.appMissingLogged = false;
			const outcome = await deps.ops.build(ctx, { force, app, protect: this.rendererKeys() });
			this.currentBuildKey = outcome.key;
			for (const warning of outcome.warnings) ctx.log.warn(warning);
			const { appVersion } = outcome.manifest;
			const failed = outcome.manifest.plugins.filter((plugin) => plugin.state === "patch-failed").map((plugin) => plugin.id);
			ctx.log.info(
				`build ${outcome.key.slice(0, 12)} for Grok Bot ${appVersion}${outcome.cached ? " (cached)" : ""}${
					failed.length > 0 ? `; failed: ${failed.join(", ")}` : ""
				}`,
			);
			this.bridge?.broadcast("build.finished", { buildKey: outcome.key, ok: true, appVersion, failed });
			await this.notifyFailures(appVersion, failed);
			return { ok: true, outcome };
		} catch (error) {
			const message = errorMessage(error);
			ctx.log.error(`build failed: ${message}`);
			this.bridge?.broadcast("build.finished", {
				buildKey: this.currentBuildKey ?? "",
				ok: false,
				appVersion: this.app?.version ?? "",
				failed: [],
			});
			await this.notifyOnce(`build:${message}`, `Better Grok Bot could not build: ${message}`);
			return { ok: false, error: message };
		} finally {
			this.building = false;
			this.scheduleStatus();
		}
	}

	/** Notifies once per newly failed plugin set per Grok Bot version (`state.notified`). */
	private async notifyFailures(appVersion: string, failed: string[]): Promise<void> {
		if (failed.length === 0) return;
		const known = (await readState(this.ctx.paths)).notified[appVersion] ?? [];
		if (failed.every((id) => known.includes(id))) return;
		await this.ctx.platform.notify(
			"Better Grok Bot",
			`Better Grok Bot: ${failed.length} plugin(s) need an update for Grok Bot ${appVersion}: ${failed.join(", ")}`,
		);
		await mutateState(this.ctx.paths, (draft) => {
			draft.notified[appVersion] = [...new Set([...(draft.notified[appVersion] ?? []), ...failed])].sort();
		});
	}

	/** Notifies once per agent process for `key`. */
	private async notifyOnce(key: string, body: string): Promise<void> {
		if (this.notified.has(key)) return;
		this.notified.add(key);
		await this.ctx.platform.notify("Better Grok Bot", body);
	}

	async status(): Promise<AgentStatus> {
		const { ctx, deps, config } = this;
		const [state, manifest, themes] = await Promise.all([
			readState(ctx.paths),
			deps.ops.readCurrentManifest(ctx).catch(() => null),
			deps.ops.listThemes(ctx, config).catch(() => []),
		]);
		const services = this.services.snapshot();
		return {
			bgbVersion: BGB_VERSION,
			platform: ctx.platform.id,
			app: this.app ? { version: this.app.version, path: this.app.root } : null,
			build: state.lastBuild,
			building: this.building,
			update: this.updateStatus,
			settings: { openAtLogin: config.openAtLogin, autoUpdate: config.autoUpdate },
			plugins: manifest?.plugins ?? [],
			themes,
			keys: services.keys,
			media: services.media,
		};
	}

	/** Broadcasts `status.changed` once per burst of changes. */
	private scheduleStatus(): void {
		clearTimeout(this.statusTimer);
		this.statusTimer = setTimeout(async () => {
			if (!this.bridge || this.stopping || this.bridge.renderers().length === 0) return;
			try {
				this.bridge.broadcast("status.changed", await this.status());
			} catch (error) {
				this.ctx.log.warn(`status: ${errorMessage(error)}`);
			}
		}, 50);
	}

	/** Writes live `renderers` (minus `"cli"` clients) and `services` to `state.json`; bursts coalesce into one write. */
	private persistLive(): void {
		if (this.persistQueued) return;
		this.persistQueued = true;
		this.stateWrites = this.stateWrites
			.then(async () => {
				this.persistQueued = false;
				await mutateState(this.ctx.paths, (draft) => {
					draft.renderers = (this.bridge?.renderers() ?? [])
						.filter((renderer) => renderer.buildKey !== "cli")
						.map((renderer) => ({ buildKey: renderer.buildKey, connectedAt: renderer.connectedAt }));
					draft.services = this.services.snapshot();
				});
			})
			.catch((error) => this.ctx.log.warn(`state: ${errorMessage(error)}`));
	}

	private async removeTrash(): Promise<void> {
		const entries = await readdir(this.ctx.paths.bin).catch(() => []);
		for (const entry of entries) {
			if (entry.startsWith(".trash-")) await rm(path.join(this.ctx.paths.bin, entry), { recursive: true, force: true }).catch(() => {});
		}
	}

	/** macOS: `launchctl setenv` does not survive a reboot, so the agent re-exports the hook at every start. */
	private async reexportHook(state: State): Promise<void> {
		const hook = state.hook;
		if (this.ctx.platform.id !== "darwin" || !hook) return;
		const current = (await this.deps.run(["launchctl", "getenv", RENDERER_URL_ENV])).stdout.trim();
		if (current === "" || current === hook.value) {
			const result = await this.deps.run(["launchctl", "setenv", RENDERER_URL_ENV, hook.value]);
			if (result.code !== 0) this.ctx.log.error(`launchctl setenv failed: ${result.stderr.trim()}`);
			return;
		}
		this.ctx.log.warn(`${RENDERER_URL_ENV} is set to ${current} by something else; leaving it`);
		await this.notifyOnce("hook-conflict", `${RENDERER_URL_ENV} is set by another program; Grok Bot starts without Better Grok Bot.`);
	}

	/** Linux: puts our desktop-entry hook back when something (e.g. an AppImage update) rewrites the entry. */
	private watchLinuxHook(state: State): void {
		const hook = state.hook;
		if (this.ctx.platform.id !== "linux" || hook?.kind !== "desktop-entry") return;
		try {
			this.hookWatcher = watch(path.dirname(hook.path), { persistent: false }, (_event, file) => {
				if (file !== null && file !== path.basename(hook.path)) return;
				clearTimeout(this.hookDebounce);
				this.hookDebounce = setTimeout(() => void this.checkLinuxHook(), 500);
			});
			this.hookWatcher.on("error", () => this.hookWatcher?.close());
		} catch (error) {
			this.ctx.log.warn(`cannot watch ${hook.path}: ${errorMessage(error)}`);
		}
	}

	private async checkLinuxHook(): Promise<void> {
		const { ctx } = this;
		const hook = (await readState(ctx.paths)).hook;
		if (!hook || this.stopping) return;
		const url = rendererUrl(ctx.paths);
		const status = await ctx.platform.hookStatus(url, this.app ?? undefined).catch(() => null);
		if (!status || status.state === "active") return;
		if (status.state === "conflict") {
			await this.notifyOnce("hook-conflict", `The Grok Bot launcher was changed to start ${status.value}; left it untouched.`);
			return;
		}
		if (!this.app) return;
		try {
			const record = await ctx.platform.hookInstall(url, this.app, hook);
			await mutateState(ctx.paths, (draft) => {
				draft.hook = record;
			});
			ctx.log.info(`restored the Grok Bot desktop-entry hook (${record.kind === "desktop-entry" ? record.path : record.kind})`);
		} catch (error) {
			if (error instanceof HookConflictError) {
				ctx.log.warn(`desktop entry now sets ${RENDERER_URL_ENV}=${error.value}; leaving it`);
				await this.notifyOnce("hook-conflict", `The Grok Bot launcher was changed to start ${error.value}; left it untouched.`);
			} else {
				ctx.log.error(`restoring the desktop-entry hook failed: ${errorMessage(error)}`);
			}
		}
	}

	private setUpdateStatus(status: UpdateStatus): void {
		this.updateStatus = status;
		this.bridge?.broadcast("update.status", status);
		this.scheduleStatus();
	}

	private async checkUpdate(): Promise<UpdateStatus> {
		const status = await checkForUpdate(this.ctx, this.deps.update);
		this.setUpdateStatus(status);
		return status;
	}

	/** Every 6 h: check; with `autoUpdate`, install (skipping a version already known to fail). */
	private async updateTick(): Promise<void> {
		if (this.stopping) return;
		const status = await this.checkUpdate();
		if (status.state !== "available" || !this.config.autoUpdate || !status.latest) return;
		const error = (await readState(this.ctx.paths)).update.error;
		if (error?.startsWith(`${status.latest} `)) {
			this.setUpdateStatus({ state: "error", current: BGB_VERSION, latest: status.latest, error });
			return;
		}
		await this.installUpdate().catch(() => undefined);
	}

	/**
	 * `update.apply` and the automatic tick: installs the latest release, then restarts onto it (after
	 * the response is sent). Single-flight: a caller arriving while an install runs joins it instead of
	 * starting a second transaction over `bin/`, and once one installed, every later caller joins that
	 * success while the agent restarts. Only a finished attempt that installed nothing lets the next start.
	 */
	private installUpdate(): Promise<void> {
		if (this.updateInFlight === null) {
			const attempt = this.applyLatestUpdate();
			this.updateInFlight = attempt;
			attempt.then(
				(installed) => {
					if (!installed) this.updateInFlight = null;
				},
				() => {
					this.updateInFlight = null;
				},
			);
		}
		return this.updateInFlight.then(() => undefined);
	}

	/** Resolves true when a new version was installed (the restart is scheduled). */
	private async applyLatestUpdate(): Promise<boolean> {
		const result = await applyUpdate(this.ctx, {
			restartAgent: true,
			restart: () => {
				setTimeout(() => void this.stop(true), 250);
			},
			onStatus: (status) => this.setUpdateStatus(status),
			deps: this.deps.update,
		});
		this.setUpdateStatus(result);
		if (result.state === "error") throw new BgbError("internal", result.error ?? "update failed");
		if (result.state === "disabled") throw new BgbError("unavailable", "self-update works only in the installed bgb binary");
		return result.state === "installed";
	}
}

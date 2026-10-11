import { existsSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import * as path from "node:path";
import { readLiveAgent, waitForAgent } from "../agent-record.ts";
import { checkSupport } from "../app/asar.ts";
import { resolveApp } from "../app/resolve.ts";
import { type BuildOutcome, build } from "../build/index.ts";
import { ensureConfig, mutateConfig, readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { ensureDataDir, rendererUrl } from "../paths.ts";
import type { AppInstall } from "../platform/types.ts";
import { mutateState, readState } from "../state.ts";
import { BGB_COMPILED, BGB_VERSION } from "../version.ts";
import { commitBinaries, removeBinaries, restorePrevious, stageBinaries } from "./binaries.ts";
import { type SetupHost, systemHost } from "./host.ts";
import { migrateGrokMods, needsGrokModsMigration, restoreGrokMods } from "./migrate-grok-mods.ts";
import { installPathEntry, removePathEntry } from "./path-entry.ts";
import { restartApp } from "./restart.ts";

export interface SetupOptions {
	yes: boolean;
	noRestart: boolean;
	force: boolean;
	/** `--app <path>`: an app dir/executable/AppImage or an `app.asar`; saved as `config.appPath`. */
	app: string | null;
	noAutostart: boolean;
	noHook: boolean;
}

/** What setup calls beyond the adapter and Step 1 state; tests replace any of them. */
export interface SetupDeps {
	host: SetupHost;
	/** True inside the compiled binary; only then does setup install `execPath` into `DATA/bin`. */
	compiled: boolean;
	execPath: string;
	resolveApp: typeof resolveApp;
	checkSupport: typeof checkSupport;
	build: typeof build;
	stageBinaries: typeof stageBinaries;
	commitBinaries: typeof commitBinaries;
	restorePrevious: typeof restorePrevious;
	removeBinaries: typeof removeBinaries;
	readLiveAgent: typeof readLiveAgent;
	waitForAgent: typeof waitForAgent;
}

interface Undo {
	/** Completes "could not …" in a failure message. */
	what: string;
	run(): Promise<unknown>;
}

const AGENT_START_TIMEOUT_MS = 15_000;

async function samePath(a: string, b: string): Promise<boolean> {
	const [ra, rb] = await Promise.all([a, b].map((p) => realpath(p).catch(() => path.resolve(p))));
	return ra === rb;
}

function printSummary(host: SetupHost, outcome: BuildOutcome, app: AppInstall, notes: readonly string[], opts: SetupOptions): void {
	host.print(`Better Grok Bot ${BGB_VERSION} is set up for Grok Bot ${app.version}.`);
	for (const warning of outcome.warnings) host.print(`warning: ${warning}`);
	// Core hooks are listed only when they failed: without them the Settings section can't appear.
	for (const plugin of outcome.manifest.plugins) {
		if (plugin.source === "core" && plugin.state === "active") continue;
		const mark = plugin.state === "active" ? "✓" : plugin.state === "disabled" ? "-" : "✗";
		const detail = plugin.errors[0] === undefined ? "" : `: ${plugin.errors[0]}`;
		host.print(`  ${mark} ${plugin.name} (${plugin.id}) ${plugin.state}${detail}`);
	}
	for (const note of notes) host.print(note);
	if (opts.noHook) host.print("No hook installed (--no-hook): run `bgb restart` to start Grok Bot with Better Grok Bot.");
	host.print("Open Grok Bot → Settings → General → Better Grok Bot");
}

/**
 * `bgb setup` (PLAN Step 3.6). Preflight (resolve and check the app, build, stage the binary, check
 * the hook) changes nothing outside `DATA`. The commit steps each register an undo; on any failure the
 * undos run in reverse and setup returns 1. Restarting Grok Bot and the summary come after the commit
 * and are never undone. Returns the exit code.
 */
export async function runSetup(ctx: CoreContext, opts: SetupOptions, overrides: Partial<SetupDeps> = {}): Promise<number> {
	const deps: SetupDeps = {
		host: systemHost(),
		compiled: BGB_COMPILED,
		execPath: process.execPath,
		resolveApp,
		checkSupport,
		build,
		stageBinaries,
		commitBinaries,
		restorePrevious,
		removeBinaries,
		readLiveAgent,
		waitForAgent,
		...overrides,
	};
	const { host } = deps;
	const { paths, platform } = ctx;
	const binPath = path.join(paths.bin, platform.binName());
	const url = rendererUrl(paths);

	let staged: string | null = null;
	let app: AppInstall;
	let outcome: BuildOutcome;
	try {
		await ensureDataDir(paths);
		const config = await ensureConfig(paths);
		const explicit = opts.app === null ? config.appPath : path.resolve(opts.app);
		try {
			app = await deps.resolveApp(ctx, explicit);
		} catch (error) {
			throw new Error(`Grok Bot not found. Install it from https://x.ai/bot or pass --app <path> (${errorMessage(error)})`);
		}
		await deps.checkSupport(ctx, app.asarPath);
		const live = await deps.readLiveAgent(paths);
		const protect = live === null ? [] : (await readState(paths)).renderers.map((renderer) => renderer.buildKey);
		outcome = await deps.build(ctx, { app, protect });
		if (deps.compiled && !(await samePath(deps.execPath, binPath))) {
			staged = await deps.stageBinaries(ctx, path.dirname(deps.execPath), BGB_VERSION);
		} else if (!existsSync(binPath)) {
			throw new Error(`no bgb binary in ${paths.bin}; run setup from the compiled bgb binary`);
		}
		if (!opts.noHook) {
			const status = await platform.hookStatus(url, app);
			if (status.state === "conflict") {
				throw new Error(
					`VITE_DEV_SERVER_URL is already set to ${status.value} by something else. Remove it, then run setup again.`,
				);
			}
		}
	} catch (error) {
		if (staged !== null) await rm(staged, { recursive: true, force: true });
		host.printError(`bgb: ${errorMessage(error)}`);
		return 1;
	}

	const undos: Undo[] = [];
	const notes: string[] = [];
	try {
		if ((await deps.readLiveAgent(paths)) !== null) {
			await platform.stopAgent(paths);
			undos.push({ what: "restart the previous agent", run: () => platform.startAgent(binPath, paths) });
		}

		if (staged !== null) {
			const replacing = existsSync(binPath);
			const dir = staged;
			staged = null; // commitBinaries consumes the staging dir
			await deps.commitBinaries(ctx, dir);
			undos.push(
				replacing
					? { what: "restore the previous bgb binaries", run: () => deps.restorePrevious(ctx) }
					: { what: "remove the installed bgb binaries", run: () => deps.removeBinaries(ctx) },
			);
		}
		const pathEntry = await installPathEntry(ctx, host);
		if (pathEntry.created) undos.push({ what: "remove the PATH entry", run: () => removePathEntry(ctx, host) });
		if (pathEntry.hint !== undefined) notes.push(pathEntry.hint);

		if (opts.app !== null) {
			const previousAppPath = (await readConfig(paths)).appPath;
			const appPath = path.resolve(opts.app);
			await mutateConfig(paths, (config) => {
				config.appPath = appPath;
			});
			undos.push({
				what: "restore appPath",
				run: () =>
					mutateConfig(paths, (config) => {
						config.appPath = previousAppPath;
					}),
			});
		}

		if (await needsGrokModsMigration(ctx, host)) {
			await migrateGrokMods(ctx, host);
			undos.push({ what: "restore grok-mods", run: () => restoreGrokMods(ctx, host) });
		}

		if (!opts.noAutostart) {
			await platform.autostartInstall(binPath, paths);
			undos.push({ what: "remove autostart", run: () => platform.autostartRemove() });
		}

		await platform.startAgent(binPath, paths);
		undos.push({ what: "stop the agent", run: () => platform.stopAgent(paths) });
		const { bridgePort } = await readConfig(paths);
		await deps.waitForAgent(paths, bridgePort, { version: BGB_VERSION, timeoutMs: AGENT_START_TIMEOUT_MS });

		const previous = (await readState(paths)).hook;
		if (!opts.noHook) {
			const record = await platform.hookInstall(url, app, previous);
			undos.push({
				what: "undo the Grok Bot hook",
				run: async () => {
					if (previous === null) await platform.hookRemove(record);
					else await platform.hookInstall(previous.value, app, previous);
					await mutateState(paths, (state) => {
						state.hook = previous;
					});
				},
			});
			await mutateState(paths, (state) => {
				state.hook = record;
			});
		} else if (previous !== null) {
			if ((await platform.hookRemove(previous)) === "removed") {
				undos.push({
					what: "reinstall the Grok Bot hook",
					run: async () => {
						const record = await platform.hookInstall(previous.value, app, previous);
						await mutateState(paths, (state) => {
							state.hook = record;
						});
					},
				});
			} else {
				notes.push("The Grok Bot hook was changed by something else; left it untouched.");
			}
			await mutateState(paths, (state) => {
				state.hook = null;
			});
		}
	} catch (error) {
		if (staged !== null) await rm(staged, { recursive: true, force: true });
		for (const undo of undos.toReversed()) {
			try {
				await undo.run();
			} catch (undoError) {
				host.printError(`bgb: could not ${undo.what}: ${errorMessage(undoError)}`);
				ctx.log.error(`setup undo: could not ${undo.what}: ${errorMessage(undoError)}`);
			}
		}
		ctx.log.error(`setup failed and was undone: ${errorMessage(error)}`);
		host.printError(`bgb: ${errorMessage(error)}`);
		return 1;
	}
	ctx.log.info(`setup finished for Grok Bot ${app.version} (build ${outcome.key.slice(0, 12)})`);

	try {
		if (app.executable !== "" && (await platform.findRunningApp(app)) !== undefined) {
			if (opts.noRestart) host.print("Restart Grok Bot to load Better Grok Bot.");
			else await restartApp(ctx, app, { yes: opts.yes, force: opts.force, interactive: host.isInteractive(), args: [] }, host);
		}
	} catch (error) {
		host.printError(`bgb: could not restart Grok Bot: ${errorMessage(error)}`);
	}
	printSummary(host, outcome, app, notes, opts);
	return 0;
}

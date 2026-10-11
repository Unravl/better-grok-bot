import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { RENDERER_URL_ENV } from "../../sdk/index.ts";
import { mutateConfig, readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { readJsonFile, writeJsonAtomic } from "../json-file.ts";
import { mutateState, readState } from "../state.ts";
import { type SetupHost, systemHost } from "./host.ts";

/** grok-mods LaunchAgents, in the order they are stopped. */
const GROK_MODS_LABELS = [
	"local.grok-mods.hook",
	"local.grok-mods.push-to-talk",
	"local.grok-mods.startup.control",
	"local.grok-mods.startup.login",
] as const;
const GROK_MODS_LOGIN_LABEL = "local.grok-mods.startup.login";
const LAUNCHER_BUNDLE_ID = "local.grok-mods.launcher";

/** Everything {@link migrateGrokMods} changed, so {@link restoreGrokMods} can undo it from any process. */
interface MigrationJournal {
	/** Labels whose plists were booted out and moved into `DATA/migrated/grok-mods/LaunchAgents/`. */
	plists: string[];
	/** `launchctl getenv VITE_DEV_SERVER_URL` before migrating; `null` when unset. */
	env: string | null;
	/** True when migrating unset that (grok-mods) value. */
	unsetEnv: boolean;
	/** App bundles moved into `DATA/migrated/grok-mods/`. */
	moved: { from: string; to: string }[];
	/** The config values migrating may change, as they were before. */
	config: { openAtLogin: boolean; disabledPlugins: string[] };
}

interface GrokModsPaths {
	launchAgents: string;
	data: string;
	migrated: string;
	journal: string;
}

function grokModsPaths(ctx: CoreContext, host: SetupHost): GrokModsPaths {
	const migrated = path.join(ctx.paths.migrated, "grok-mods");
	return {
		launchAgents: path.join(host.home, "Library", "LaunchAgents"),
		data: path.join(host.home, "Library", "Application Support", "GrokMods"),
		migrated,
		journal: path.join(migrated, "migration.json"),
	};
}

/** Moves a file or directory, copying when `from` and `to` are on different volumes. */
async function move(from: string, to: string): Promise<void> {
	await mkdir(path.dirname(to), { recursive: true });
	try {
		await rename(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		await cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
		await rm(from, { recursive: true, force: true });
	}
}

/** True on macOS when grok-mods left LaunchAgents or its data dir and setup has not migrated them yet. */
export async function needsGrokModsMigration(ctx: CoreContext, host: SetupHost = systemHost()): Promise<boolean> {
	if (ctx.platform.id !== "darwin" || (await readState(ctx.paths)).migratedGrokMods) return false;
	const where = grokModsPaths(ctx, host);
	if (existsSync(where.data)) return true;
	const agents = await readdir(where.launchAgents).catch(() => [] as string[]);
	return agents.some((name) => name.startsWith("local.grok-mods.") && name.endsWith(".plist"));
}

async function launchctlGetenv(host: SetupHost): Promise<string | null> {
	const result = await host.exec(["launchctl", "getenv", RENDERER_URL_ENV]);
	const value = result.code === 0 ? result.stdout.trim() : "";
	return value === "" ? null : value;
}

/** grok-mods `config.json` `disabled` ids; none when the file is missing or malformed. */
async function grokModsDisabled(ctx: CoreContext, dataDir: string): Promise<string[]> {
	try {
		const config = await readJsonFile(path.join(dataDir, "config.json"));
		const disabled = (config as { disabled?: unknown } | undefined)?.disabled;
		return Array.isArray(disabled) ? disabled.filter((id): id is string => typeof id === "string") : [];
	} catch (error) {
		ctx.log.warn(`grok-mods config.json not migrated: ${errorMessage(error)}`);
		return [];
	}
}

/**
 * Moves a grok-mods (macOS) install out of the way, reversibly:
 * 1. boots out and moves its LaunchAgent plists into `DATA/migrated/grok-mods/LaunchAgents/` (a login
 *    plist turns on `openAtLogin`);
 * 2. saves `launchctl getenv VITE_DEV_SERVER_URL` to `env.txt` and unsets a grok-mods value;
 * 3. moves the `Grok Bot Modded.app` launcher and the push-to-talk helper app into `DATA/migrated/grok-mods/`;
 * 4. adds grok-mods' disabled mods to `disabledPlugins`;
 * 5. names grok-mods user mods, which are not migrated;
 * 6. leaves the rest of grok-mods' data in place and sets `state.migratedGrokMods`.
 * Every step is journaled; on failure the finished steps are restored and the error rethrown.
 */
export async function migrateGrokMods(ctx: CoreContext, host: SetupHost = systemHost()): Promise<void> {
	const where = grokModsPaths(ctx, host);
	const before = await readConfig(ctx.paths);
	const journal: MigrationJournal = {
		plists: [],
		env: null,
		unsetEnv: false,
		moved: [],
		config: { openAtLogin: before.openAtLogin, disabledPlugins: [...before.disabledPlugins] },
	};
	await mkdir(path.join(where.migrated, "LaunchAgents"), { recursive: true });
	const save = (): Promise<void> => writeJsonAtomic(where.journal, journal);
	await save();
	try {
		for (const label of GROK_MODS_LABELS) {
			const plist = path.join(where.launchAgents, `${label}.plist`);
			if (!existsSync(plist)) continue;
			// Fails when the job is not loaded, which is fine.
			await host.exec(["launchctl", "bootout", `gui/${host.uid}/${label}`]);
			await move(plist, path.join(where.migrated, "LaunchAgents", `${label}.plist`));
			journal.plists.push(label);
			await save();
		}
		if (journal.plists.includes(GROK_MODS_LOGIN_LABEL)) {
			await mutateConfig(ctx.paths, (config) => {
				config.openAtLogin = true;
			});
		}

		journal.env = await launchctlGetenv(host);
		await writeFile(path.join(where.migrated, "env.txt"), journal.env ?? "");
		if (journal.env?.endsWith("/GrokMods/current/renderer/index.html")) {
			const result = await host.exec(["launchctl", "unsetenv", RENDERER_URL_ENV]);
			if (result.code !== 0) throw new Error(`launchctl unsetenv ${RENDERER_URL_ENV} failed: ${result.stderr.trim()}`);
			journal.unsetEnv = true;
		}
		await save();

		const launcher = path.join(host.home, "Applications", "Grok Bot Modded.app");
		const launcherPlist = await readFile(path.join(launcher, "Contents", "Info.plist"), "utf8").catch(() => "");
		const apps = [
			...(launcherPlist.includes(LAUNCHER_BUNDLE_ID) ? [launcher] : []),
			path.join(where.data, "helpers", "Grok Mods Push to Talk.app"),
		];
		for (const app of apps) {
			if (!existsSync(app)) continue;
			const to = path.join(where.migrated, path.basename(app));
			await move(app, to);
			journal.moved.push({ from: app, to });
			await save();
		}

		const disabled = await grokModsDisabled(ctx, where.data);
		if (disabled.length > 0) {
			await mutateConfig(ctx.paths, (config) => {
				config.disabledPlugins = [...new Set([...config.disabledPlugins, ...disabled])];
			});
		}

		const userMods = (await readdir(path.join(where.data, "mods"), { withFileTypes: true }).catch(() => []))
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => entry.name);
		if (userMods.length > 0) {
			host.print(`Not migrated: grok-mods mods must be rebuilt as Better Grok Bot plugins: ${userMods.join(", ")}`);
		}

		await mutateState(ctx.paths, (state) => {
			state.migratedGrokMods = true;
		});
		host.print(
			existsSync(where.data)
				? `Migrated grok-mods. ${where.data} was left in place; once Better Grok Bot works you may delete it and ${ctx.paths.migrated}.`
				: `Migrated grok-mods. Once Better Grok Bot works you may delete ${ctx.paths.migrated}.`,
		);
		ctx.log.info(`migrated grok-mods: ${JSON.stringify(journal)}`);
	} catch (error) {
		await restoreGrokMods(ctx, host).catch((restoreError: unknown) => {
			ctx.log.error(`restoring grok-mods after a failed migration: ${errorMessage(restoreError)}`);
		});
		throw error;
	}
}

/**
 * Undoes {@link migrateGrokMods} from its journal: moves the apps and plists back, bootstraps each plist,
 * re-exports the saved `VITE_DEV_SERVER_URL` if migrating unset it, restores `openAtLogin` and
 * `disabledPlugins`, and clears `state.migratedGrokMods`. Safe to repeat; throws listing whatever could
 * not be restored (keeping the journal for another attempt).
 */
export async function restoreGrokMods(ctx: CoreContext, host: SetupHost = systemHost()): Promise<void> {
	const where = grokModsPaths(ctx, host);
	const journal = (await readJsonFile(where.journal)) as MigrationJournal | undefined;
	const failures: string[] = [];
	if (journal !== undefined) {
		for (const { from, to } of journal.moved.toReversed()) {
			if (!existsSync(to)) continue;
			await move(to, from).catch((error: unknown) => failures.push(`${from}: ${errorMessage(error)}`));
		}
		for (const label of journal.plists) {
			const plist = path.join(where.launchAgents, `${label}.plist`);
			const migrated = path.join(where.migrated, "LaunchAgents", `${label}.plist`);
			if (existsSync(migrated)) {
				try {
					await move(migrated, plist);
				} catch (error) {
					failures.push(`${plist}: ${errorMessage(error)}`);
					continue;
				}
			}
			const result = await host.exec(["launchctl", "bootstrap", `gui/${host.uid}`, plist]);
			if (result.code !== 0) ctx.log.warn(`launchctl bootstrap ${plist}: ${result.stderr.trim()}`);
		}
		if (journal.unsetEnv && journal.env !== null) {
			const result = await host.exec(["launchctl", "setenv", RENDERER_URL_ENV, journal.env]);
			if (result.code !== 0) failures.push(`launchctl setenv ${RENDERER_URL_ENV}: ${result.stderr.trim()}`);
		}
		await mutateConfig(ctx.paths, (config) => {
			config.openAtLogin = journal.config.openAtLogin;
			config.disabledPlugins = journal.config.disabledPlugins;
		});
	}
	await mutateState(ctx.paths, (state) => {
		state.migratedGrokMods = false;
	});
	if (failures.length > 0) throw new Error(`could not restore grok-mods: ${failures.join("; ")}`);
	await rm(where.journal, { force: true });
	await rm(path.join(where.migrated, "env.txt"), { force: true });
	for (const dir of [path.join(where.migrated, "LaunchAgents"), where.migrated]) await rmdir(dir).catch(() => undefined);
}

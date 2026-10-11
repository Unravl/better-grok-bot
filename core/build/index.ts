import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { BOOT_GLOBAL, type BootPayload, type BuildManifest, INJECT_DIR, type PluginStatus } from "../../sdk/index.ts";
import { AppChangedError, type AsarStamp, asarStamp, checkSupport, extractRenderer, fingerprint } from "../app/asar.ts";
import { readAppPackage } from "../app/package.ts";
import { resolveApp } from "../app/resolve.ts";
import { type Config, readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { EMBED_HASH, LOADER_JS } from "../generated/embedded.ts";
import { readJsonFile, writeJsonAtomic } from "../json-file.ts";
import { withLock } from "../lock.ts";
import type { AppInstall } from "../platform/types.ts";
import { discoverPlugins } from "../plugins/discover.ts";
import type { LoadedPlugin } from "../plugins/types.ts";
import { mutateState } from "../state.ts";
import { type LoadedTheme, loadThemes } from "../themes/index.ts";
import { BGB_VERSION } from "../version.ts";
import { injectScripts, pinResources } from "./html.ts";
import { computeBuildKey } from "./key.ts";
import { PatchWorkspace } from "./patch.ts";

export interface BuildOptions {
	/** Rebuild even when a build with this key exists. */
	force?: boolean;
	/** Default: `resolveApp(config.appPath)`. */
	app?: AppInstall;
	/** Build keys never pruned (renderers still running them). */
	protect?: string[];
}

export interface BuildOutcome {
	key: string;
	dir: string;
	manifest: BuildManifest;
	cached: boolean;
	/** Discovery problems that kept a plugin out of the build entirely. */
	warnings: string[];
}

/** Internal: `checkAsar` builds into a throwaway `DATA` without repointing `current` or recording `lastBuild`. */
export interface RunBuildOptions extends BuildOptions {
	publish?: boolean;
}

const KEEP_BUILDS = 3;
const TEMP_PREFIX = ".tmp-";
const RETIRED_PREFIX = ".retired-";
/** Leftover temp/retired dirs younger than this may belong to a concurrent build of another process. */
const STALE_TEMP_MS = 10 * 60 * 1000;
const APP_CHANGED_RETRY_MS = 5_000;

/** `<appVersion>-<first 12 hex chars of the key>`. */
export function buildDirName(appVersion: string, key: string): string {
	return `${appVersion}-${key.slice(0, 12)}`;
}

/** The manifest of the build with this key and app version, or `null` when there is none. */
export async function readBuildManifest(ctx: CoreContext, key: string, appVersion: string): Promise<BuildManifest | null> {
	const value = await readJsonFile(path.join(ctx.paths.builds, buildDirName(appVersion, key), "manifest.json")).catch(() => undefined);
	return value === undefined ? null : (value as BuildManifest);
}

/** The manifest of the build `DATA/current` points at, or `null`. */
export async function readCurrentManifest(ctx: CoreContext): Promise<BuildManifest | null> {
	const value = await readJsonFile(path.join(ctx.paths.current, "manifest.json")).catch(() => undefined);
	return value === undefined ? null : (value as BuildManifest);
}

function initialStatus(plugin: LoadedPlugin): PluginStatus {
	const def = plugin.definition;
	const pkg = plugin.pkg;
	return {
		id: plugin.id,
		name: def?.name ?? pkg?.name ?? plugin.id,
		description: def?.description ?? pkg?.description ?? "",
		version: def?.version ?? pkg?.version ?? "?",
		authors: [...(def?.authors ?? pkg?.authors ?? [])],
		source: plugin.source,
		state: plugin.state ?? "patch-failed",
		errors: [...plugin.errors],
		patches: [],
		permissions: [...(def?.permissions ?? pkg?.permissions ?? [])],
		granted: [...plugin.granted],
		settings: def?.settings ?? pkg?.settings ?? {},
		hasRuntime: plugin.runtimeJs !== undefined,
	};
}

interface AssembleInput {
	app: AppInstall;
	appFingerprint: string;
	key: string;
	config: Config;
	plugins: readonly LoadedPlugin[];
	themes: readonly LoadedTheme[];
	staging: string;
	final: string;
	expected: AsarStamp;
}

/** Extracts the renderer into `staging`, applies plugins, injects BGB and pins HTML references to `final`. */
async function assemble(ctx: CoreContext, input: AssembleInput): Promise<BuildManifest> {
	const files = await extractRenderer(ctx, input.app.asarPath, input.staging, { expected: input.expected });
	const workspace = new PatchWorkspace(input.staging, files);
	const statuses: PluginStatus[] = [];
	const runtimes: { id: string; js: string }[] = [];
	const styles: BootPayload["styles"] = [];
	for (const plugin of input.plugins) {
		const status = initialStatus(plugin);
		statuses.push(status);
		if (plugin.state !== undefined) continue;
		const attempt =
			plugin.definition !== undefined
				? await workspace.attempt(plugin.definition.patches ?? [])
				: plugin.pkg !== undefined
					? await workspace.attemptIsolated(plugin.pkg, { workerUrl: ctx.patchWorkerUrl })
					: undefined;
		if (attempt === undefined) continue;
		status.patches = attempt.results;
		if (attempt.errors.length > 0) {
			status.errors.push(...attempt.errors);
			continue;
		}
		workspace.commit(attempt.edits);
		status.state = "active";
		if (plugin.runtimeJs !== undefined) runtimes.push({ id: plugin.id, js: plugin.runtimeJs });
		if (plugin.stylesCss !== undefined) styles.push({ id: plugin.id, kind: "plugin", css: plugin.stylesCss });
	}
	await workspace.flush();
	for (const theme of input.themes) {
		if (theme.info.enabled && theme.css !== undefined) styles.push({ id: theme.info.id, kind: "theme", css: theme.css });
	}

	const manifest: BuildManifest = {
		bgbVersion: BGB_VERSION,
		buildFormat: 1,
		buildKey: input.key,
		platform: ctx.platform.id,
		appVersion: input.app.version,
		appFingerprint: input.appFingerprint,
		builtAt: new Date().toISOString(),
		plugins: statuses,
		themes: input.themes.map((theme) => theme.info),
	};
	const boot: BootPayload = { manifest, bridge: { port: input.config.bridgePort, token: input.config.bridgeToken }, styles };
	const injectDir = path.join(input.staging, ...INJECT_DIR.split("/"));
	await mkdir(path.join(injectDir, "plugins"), { recursive: true });
	await writeFile(path.join(injectDir, "boot.js"), `globalThis.${BOOT_GLOBAL}=${JSON.stringify(boot)};\n${LOADER_JS}`);
	for (const runtime of runtimes) await writeFile(path.join(injectDir, "plugins", `${runtime.id}.js`), runtime.js);
	const indexFile = path.join(input.staging, "index.html");
	await writeFile(indexFile, injectScripts(await readFile(indexFile, "utf8"), runtimes.map((runtime) => runtime.id)));
	for (const file of files.filter((name) => name.endsWith(".html"))) {
		const full = path.join(input.staging, ...file.split("/"));
		await writeFile(full, await pinResources(await readFile(full, "utf8"), file, input.staging, input.final));
	}
	return manifest;
}

/** Renames the staged build into place. Returns true when an identical build won the race (counts as cached). */
async function publish(temp: string, dir: string, force: boolean): Promise<boolean> {
	try {
		await rename(temp, dir);
		return false;
	} catch (error) {
		if (!existsSync(dir)) throw error;
		if (!force) return true;
	}
	const retired = path.join(path.dirname(dir), `${RETIRED_PREFIX}${randomBytes(6).toString("hex")}`);
	await rename(dir, retired);
	await rename(temp, dir);
	await rm(retired, { recursive: true, force: true });
	return false;
}

/**
 * Keeps the {@link KEEP_BUILDS} newest builds; never deletes `keep`, the target of `current` or any build
 * whose key is in `protect`. Deletes temp/retired leftovers older than 10 minutes.
 */
async function prune(ctx: CoreContext, keep: string, protect: readonly string[]): Promise<void> {
	const currentTarget = await realpath(ctx.paths.current).catch(() => undefined);
	const now = Date.now();
	const builds: { name: string; full: string; mtimeMs: number }[] = [];
	for (const entry of await readdir(ctx.paths.builds, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const full = path.join(ctx.paths.builds, entry.name);
		const info = await stat(full).catch(() => undefined);
		if (info === undefined) continue;
		if (entry.name.startsWith(TEMP_PREFIX) || entry.name.startsWith(RETIRED_PREFIX)) {
			if (now - info.mtimeMs > STALE_TEMP_MS) await rm(full, { recursive: true, force: true });
			continue;
		}
		builds.push({ name: entry.name, full, mtimeMs: info.mtimeMs });
	}
	builds.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const build of builds.slice(KEEP_BUILDS)) {
		if (build.full === keep || protect.some((key) => build.name.endsWith(`-${key.slice(0, 12)}`))) continue;
		if (currentTarget !== undefined && (await realpath(build.full).catch(() => undefined)) === currentTarget) continue;
		await rm(build.full, { recursive: true, force: true });
	}
}

async function buildOnce(ctx: CoreContext, options: RunBuildOptions): Promise<BuildOutcome> {
	const config = await readConfig(ctx.paths);
	const resolved = options.app ?? (await resolveApp(ctx, config.appPath));
	const expected = await asarStamp(resolved.asarPath);
	// Re-read after stamping, so the version in the dir name matches the bytes fingerprinted and extracted.
	const app: AppInstall = { ...resolved, version: (await readAppPackage(resolved.asarPath)).version };
	await checkSupport(ctx, app.asarPath);
	const appFingerprint = await fingerprint(ctx, app.asarPath);
	const { plugins, warnings } = await discoverPlugins(ctx, config, ctx.platform.id);
	const themes = await loadThemes(ctx, config);
	const key = await computeBuildKey({
		bgbVersion: BGB_VERSION,
		embedHash: EMBED_HASH,
		platform: ctx.platform.id,
		appFingerprint,
		buildsDir: ctx.paths.builds,
		bridgePort: config.bridgePort,
		bridgeToken: config.bridgeToken,
		plugins,
		themes: themes.map((theme) => ({ id: theme.info.id, enabled: theme.info.enabled, bytes: theme.bytes })),
	});
	const dir = path.join(ctx.paths.builds, buildDirName(app.version, key));
	const manifestFile = path.join(dir, "manifest.json");
	await mkdir(ctx.paths.builds, { recursive: true });

	let cached = options.force !== true && existsSync(manifestFile);
	if (cached) {
		const now = new Date();
		await utimes(dir, now, now);
	} else {
		const temp = await mkdtemp(path.join(ctx.paths.builds, TEMP_PREFIX));
		try {
			const manifest = await assemble(ctx, {
				app,
				appFingerprint,
				key,
				config,
				plugins,
				themes,
				staging: path.join(temp, "renderer"),
				final: path.join(dir, "renderer"),
				expected,
			});
			await writeJsonAtomic(path.join(temp, "manifest.json"), manifest);
			cached = await publish(temp, dir, options.force === true);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	}

	const manifest = (await readJsonFile(manifestFile)) as BuildManifest;
	if (options.publish !== false) {
		await ctx.platform.pointCurrent(ctx.paths, dir);
		await mutateState(ctx.paths, (state) => {
			state.lastBuild = { key, appVersion: app.version, builtAt: manifest.builtAt };
		});
	}
	await prune(ctx, dir, options.protect ?? []);
	return { key, dir, manifest, cached, warnings };
}

/** {@link build} with the internal `publish` switch. Retries once, after 5 s, when the app changes mid-build. */
export async function runBuild(ctx: CoreContext, options: RunBuildOptions = {}): Promise<BuildOutcome> {
	return withLock(ctx.paths, "build", async () => {
		try {
			return await buildOnce(ctx, options);
		} catch (error) {
			if (!(error instanceof AppChangedError)) throw error;
			ctx.log.warn(`${error.message}; retrying in 5 s`);
			await Bun.sleep(APP_CHANGED_RETRY_MS);
			return buildOnce(ctx, options);
		}
	});
}

/**
 * Produces (or reuses) the patched renderer for the app, under the build lock: resolve the app, check
 * support, fingerprint, discover plugins and themes, compute the key, then extract → patch → inject →
 * pin → publish to `DATA/builds/<appVersion>-<key12>`, point `current` at it, record `lastBuild` and prune.
 */
export async function build(ctx: CoreContext, options: BuildOptions = {}): Promise<BuildOutcome> {
	return runBuild(ctx, options);
}

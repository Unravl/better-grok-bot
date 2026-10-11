import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { readJsonFile, writeJsonAtomic } from "../json-file.ts";
import { withLock } from "../lock.ts";
import { buildPluginPackage, packageFiles } from "./author.ts";
import { type PackageContents, readPackageContents } from "./community.ts";
import { hashTree } from "./package.ts";
import { isRecord } from "./validate.ts";

/** Cache marker in `DATA/cache/dev/<id>/`: which source dir, at which source-tree hash, it was built from. */
const DEV_MARKER = ".bgb-dev.json";

async function readDirs(file: string): Promise<string[]> {
	const value = await readJsonFile(file);
	if (value === undefined) return [];
	if (!isRecord(value) || !Array.isArray(value.dirs) || !value.dirs.every((dir) => typeof dir === "string")) {
		throw new Error(`${file}: expected {"dirs": [<path>, …]}`);
	}
	return value.dirs;
}

/** Absolute plugin source dirs from `DATA/dev-plugins.json` (`{dirs: string[]}`). */
export async function readDevDirs(ctx: CoreContext): Promise<string[]> {
	return readDirs(ctx.paths.devPlugins);
}

async function mutateDevDirs(ctx: CoreContext, fn: (dirs: string[]) => string[]): Promise<void> {
	// dev-plugins.json is config-like; the config lock serializes its writers.
	await withLock(ctx.paths, "config", async () => {
		await writeJsonAtomic(ctx.paths.devPlugins, { dirs: fn(await readDirs(ctx.paths.devPlugins)) });
	});
}

/** Adds a source dir (stored absolute). Only `bgb dev`, after its confirmation prompt, calls this. */
export async function addDevDir(ctx: CoreContext, dir: string): Promise<void> {
	const absolute = path.resolve(dir);
	await mutateDevDirs(ctx, (dirs) => (dirs.includes(absolute) ? dirs : [...dirs, absolute]));
}

export async function removeDevDir(ctx: CoreContext, dir: string): Promise<void> {
	const absolute = path.resolve(dir);
	await mutateDevDirs(ctx, (dirs) => dirs.filter((candidate) => candidate !== absolute));
}

export interface DevPlugin {
	/** Source dir from `dev-plugins.json`. */
	sourceDir: string;
	/** The built plugin id; the source dir's name when the build failed. */
	id: string;
	/** Built package dir under `DATA/cache/dev/`, when the build succeeded. */
	dir: string | undefined;
	contents: PackageContents | undefined;
	errors: string[];
}

async function sourceTreeHash(dir: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	await hashTree(hasher, dir);
	return hasher.digest("hex");
}

/** Cached builds by source dir: `cache/dev/*\/.bgb-dev.json`. */
async function cachedBuilds(cacheDir: string): Promise<Map<string, { dir: string; treeHash: string }>> {
	const builds = new Map<string, { dir: string; treeHash: string }>();
	let names: string[];
	try {
		names = await readdir(cacheDir);
	} catch {
		return builds;
	}
	for (const name of names) {
		if (name.startsWith(".")) continue;
		const marker = await readJsonFile(path.join(cacheDir, name, DEV_MARKER)).catch(() => undefined);
		if (isRecord(marker) && typeof marker.sourceDir === "string" && typeof marker.treeHash === "string") {
			builds.set(marker.sourceDir, { dir: path.join(cacheDir, name), treeHash: marker.treeHash });
		}
	}
	return builds;
}

/**
 * Builds every dev dir into `DATA/cache/dev/<id>/`, reusing a cached build while the source tree hash is
 * unchanged. Building evaluates the dir's `plugin.ts` on the host.
 */
export async function loadDevPlugins(ctx: CoreContext): Promise<DevPlugin[]> {
	const sourceDirs = await readDevDirs(ctx);
	if (sourceDirs.length === 0) return [];
	const cacheDir = path.join(ctx.paths.cache, "dev");
	await mkdir(cacheDir, { recursive: true });
	const cache = await cachedBuilds(cacheDir);
	const plugins: DevPlugin[] = [];
	const owners = new Map<string, string>();
	for (const sourceDir of sourceDirs) {
		const plugin: DevPlugin = { sourceDir, id: path.basename(sourceDir), dir: undefined, contents: undefined, errors: [] };
		plugins.push(plugin);
		try {
			const treeHash = await sourceTreeHash(sourceDir);
			const cached = cache.get(sourceDir);
			const claim = (id: string): void => {
				const owner = owners.get(id);
				if (owner !== undefined) throw new Error(`plugin id "${id}" is already provided by the dev plugin in ${owner}`);
				owners.set(id, sourceDir);
			};
			if (cached !== undefined && cached.treeHash === treeHash) {
				const contents = await readPackageContents(cached.dir);
				claim(contents.pkg.id);
				plugin.contents = contents;
				plugin.dir = cached.dir;
			} else {
				const built = await buildPluginPackage(ctx, sourceDir);
				claim(built.json.id);
				const temp = await mkdtemp(path.join(cacheDir, ".tmp-"));
				for (const [name, content] of packageFiles(built)) await writeFile(path.join(temp, name), content);
				await writeFile(path.join(temp, DEV_MARKER), JSON.stringify({ sourceDir, treeHash }));
				const target = path.join(cacheDir, built.json.id);
				if (cached !== undefined) await rm(cached.dir, { recursive: true, force: true });
				await rm(target, { recursive: true, force: true });
				await rename(temp, target);
				plugin.contents = await readPackageContents(target);
				plugin.dir = target;
			}
			plugin.id = plugin.contents.pkg.id;
		} catch (error) {
			plugin.errors.push(`dev build of ${sourceDir} failed: ${errorMessage(error)}`);
		}
	}
	return plugins;
}

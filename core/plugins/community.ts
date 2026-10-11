import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { PluginPackageJson } from "../../sdk/index.ts";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { readJsonFile } from "../json-file.ts";
import { SOURCE_RECORD, compareNames } from "./package.ts";
import { PACKAGE_JSON_LIMITS, isRecord, validatePackage } from "./validate.ts";

/** `.bgb-source.json` in each community plugin dir: where it came from, for `plugins update`. */
export interface SourceRecord {
	source: string;
	version: string;
	sha256: string;
	installedAt: string;
}

/** A package directory read and validated: `plugin.json` plus its runtime and styles text. */
export interface PackageContents {
	pkg: PluginPackageJson;
	runtimeJs: string | undefined;
	stylesCss: string | undefined;
}

/** Reads `plugin.json` (≤ 1 MiB), validates it with its assets and reads `runtime.js`/`styles.css`. */
export async function readPackageContents(dir: string): Promise<PackageContents> {
	const file = path.join(dir, "plugin.json");
	if ((await stat(file)).size > PACKAGE_JSON_LIMITS.pluginJsonBytes) throw new Error("plugin.json is larger than 1 MiB");
	const pkg = await validatePackage(JSON.parse(await readFile(file, "utf8")), dir);
	return {
		pkg,
		runtimeJs: pkg.runtime === null ? undefined : await readFile(path.join(dir, pkg.runtime), "utf8"),
		stylesCss: pkg.styles === null ? undefined : await readFile(path.join(dir, pkg.styles), "utf8"),
	};
}

export async function readSourceRecord(dir: string): Promise<SourceRecord | null> {
	const value = await readJsonFile(path.join(dir, SOURCE_RECORD)).catch(() => undefined);
	if (!isRecord(value)) return null;
	const { source, version, sha256, installedAt } = value;
	if (typeof source !== "string" || typeof version !== "string" || typeof sha256 !== "string" || typeof installedAt !== "string") return null;
	return { source, version, sha256, installedAt };
}

export interface CommunityPlugin {
	/** The directory name (the plugin id when valid). */
	id: string;
	dir: string;
	contents: PackageContents | undefined;
	source: SourceRecord | null;
	errors: string[];
}

/** Every `DATA/plugins/<id>/` (dirs starting with `.` skipped), sorted by id, read and validated. */
export async function listCommunityPlugins(ctx: CoreContext): Promise<CommunityPlugin[]> {
	let entries: { name: string; isDirectory(): boolean }[];
	try {
		entries = await readdir(ctx.paths.plugins, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const plugins: CommunityPlugin[] = [];
	for (const entry of entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).sort((a, b) => compareNames(a.name, b.name))) {
		const dir = path.join(ctx.paths.plugins, entry.name);
		const plugin: CommunityPlugin = { id: entry.name, dir, contents: undefined, source: await readSourceRecord(dir), errors: [] };
		try {
			plugin.contents = await readPackageContents(dir);
			if (plugin.contents.pkg.id !== entry.name) {
				plugin.errors.push(`plugin.json id "${plugin.contents.pkg.id}" does not match its directory name "${entry.name}"`);
				plugin.contents = undefined;
			}
		} catch (error) {
			plugin.errors.push(errorMessage(error));
		}
		plugins.push(plugin);
	}
	return plugins;
}

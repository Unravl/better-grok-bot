import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { PERMISSIONS, type Permission, type PluginPackageJson, type PluginUpdateResult } from "../../sdk/index.ts";
import { mutateConfig, readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { BgbError, errorMessage } from "../errors.ts";
import { readJsonFile, writeJsonAtomic } from "../json-file.ts";
import { withLock } from "../lock.ts";
import { BUNDLED_PLUGINS } from "./bundled.ts";
import { type SourceRecord, readSourceRecord } from "./community.ts";
import { CORE_HOOKS } from "./core.ts";
import { downloadBytes } from "./download.ts";
import { PACKAGE_LIMITS, SOURCE_RECORD, hashFiles, readPackageDir, readZip } from "./package.ts";
import { PACKAGE_JSON_LIMITS, isRecord, validatePackage } from "./validate.ts";

export type PluginSourceSpec =
	| { kind: "dir"; path: string }
	| { kind: "file"; path: string }
	| { kind: "url"; url: string }
	| { kind: "github"; owner: string; repo: string; tag: string | null };

export interface Inspection {
	inspectionId: string;
	sha256: string;
	json: PluginPackageJson;
	replaces: { version: string; granted: Permission[]; enabled: boolean } | null;
}

/** Inspections expire after this long; the next inspect/install deletes them. */
export const INSPECTION_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const INSPECTION_ID = /^[0-9a-f]{16}$/;
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * Classifies a plugin source: an existing directory with `plugin.json`, an existing `.bgbplugin`/`.zip`
 * file, an `https://` URL (a zip), or `github:owner/repo[@tag]`. Anything else → `bad-request`.
 */
export function parseSource(source: string): PluginSourceSpec {
	const trimmed = source.trim();
	if (trimmed.startsWith("github:")) {
		const match = /^github:([^/@\s]+)\/([^/@\s]+)(?:@(\S+))?$/.exec(trimmed);
		if (match === null || !GITHUB_NAME.test(match[1] ?? "") || !GITHUB_NAME.test(match[2] ?? "")) {
			throw new BgbError("bad-request", `expected github:owner/repo or github:owner/repo@tag, got ${source}`);
		}
		return { kind: "github", owner: match[1] ?? "", repo: match[2] ?? "", tag: match[3] ?? null };
	}
	if (/^https:\/\//i.test(trimmed)) {
		try {
			return { kind: "url", url: new URL(trimmed).href };
		} catch {
			throw new BgbError("bad-request", `invalid URL ${source}`);
		}
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) throw new BgbError("bad-request", `only https:// URLs are supported, got ${source}`);
	const resolved = path.resolve(trimmed);
	const info = statSync(resolved, { throwIfNoEntry: false });
	if (info === undefined) throw new BgbError("not-found", `${resolved} does not exist`);
	if (info.isDirectory()) {
		if (!existsSync(path.join(resolved, "plugin.json"))) {
			throw new BgbError("bad-request", `${resolved} has no plugin.json (build it first: bgb plugin build ${resolved})`);
		}
		return { kind: "dir", path: resolved };
	}
	if (/\.(bgbplugin|zip)$/i.test(resolved)) return { kind: "file", path: resolved };
	throw new BgbError("bad-request", `${resolved} is not a .bgbplugin file or a plugin directory`);
}

/** The canonical string recorded in `.bgb-source.json` and re-resolved by `updatePlugin`. */
function sourceString(spec: PluginSourceSpec): string {
	switch (spec.kind) {
		case "dir":
		case "file":
			return spec.path;
		case "url":
			return spec.url;
		case "github":
			return `github:${spec.owner}/${spec.repo}${spec.tag === null ? "" : `@${spec.tag}`}`;
	}
}

async function githubAssetUrl(spec: Extract<PluginSourceSpec, { kind: "github" }>, signal: AbortSignal): Promise<string> {
	const release = spec.tag === null ? "latest" : `tags/${encodeURIComponent(spec.tag)}`;
	const api = `https://api.github.com/repos/${spec.owner}/${spec.repo}/releases/${release}`;
	const body = await downloadBytes(api, {
		maxBytes: 5 * 1024 * 1024,
		signal,
		headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
		what: `the ${spec.tag ?? "latest"} release of ${spec.owner}/${spec.repo}`,
	});
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(body));
	} catch {
		throw new BgbError("unavailable", `GitHub returned invalid JSON for ${spec.owner}/${spec.repo}`);
	}
	const assets = isRecord(parsed) && Array.isArray(parsed.assets) ? parsed.assets.filter(isRecord) : [];
	const names = assets.map((asset) => (typeof asset.name === "string" ? asset.name : "?"));
	const packages = assets.filter((asset) => typeof asset.name === "string" && asset.name.endsWith(".bgbplugin"));
	const [only] = packages;
	if (packages.length !== 1 || only === undefined || typeof only.browser_download_url !== "string") {
		throw new BgbError(
			"bad-request",
			`the ${spec.tag ?? "latest"} release of ${spec.owner}/${spec.repo} needs exactly one .bgbplugin asset; it has: ${names.join(", ") || "none"}`,
		);
	}
	return only.browser_download_url;
}

/** Fetches or reads the package once; returns its files and sha256 (zip bytes, or tree hash for a dir). */
async function fetchPackage(spec: PluginSourceSpec): Promise<{ files: Map<string, Uint8Array>; sha256: string }> {
	const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
	if (spec.kind === "dir") {
		const files = await readPackageDir(spec.path);
		const hasher = new Bun.CryptoHasher("sha256");
		hashFiles(hasher, files);
		return { files, sha256: hasher.digest("hex") };
	}
	let bytes: Uint8Array;
	if (spec.kind === "file") {
		if ((await stat(spec.path)).size > PACKAGE_LIMITS.maxEntryBytes) throw new BgbError("bad-request", `${spec.path} is larger than 20 MB`);
		bytes = new Uint8Array(await readFile(spec.path));
	} else {
		const url = spec.kind === "url" ? spec.url : await githubAssetUrl(spec, signal);
		bytes = await downloadBytes(url, { maxBytes: PACKAGE_LIMITS.maxEntryBytes, signal });
	}
	return { files: readZip(bytes), sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
}

function inspectRoot(ctx: CoreContext): string {
	return path.join(ctx.paths.cache, "inspect");
}

/** The installed package an update was inspected against (its `.bgb-source.json` identity). */
type ExpectedInstall = Pick<SourceRecord, "source" | "sha256" | "installedAt">;

interface InspectionRecord {
	source: string;
	sha256: string;
	createdAt: number;
	json: PluginPackageJson;
	/** Set by `updatePlugin`: the commit fails unless this package is still the installed one. */
	expected?: ExpectedInstall;
}

async function readInspectionRecord(dir: string): Promise<InspectionRecord | undefined> {
	const value = await readJsonFile(path.join(dir, "inspection.json")).catch(() => undefined);
	if (!isRecord(value) || typeof value.source !== "string" || typeof value.sha256 !== "string" || typeof value.createdAt !== "number") {
		return undefined;
	}
	// Written by inspectSource after validatePackage; only its envelope can be damaged on disk.
	return value as unknown as InspectionRecord;
}

/** Deletes inspections older than {@link INSPECTION_TTL_MS} (and unreadable ones). */
async function pruneInspections(ctx: CoreContext): Promise<void> {
	const root = inspectRoot(ctx);
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of names) {
		const dir = path.join(root, name);
		const record = await readInspectionRecord(dir);
		const createdAt = record?.createdAt ?? (await stat(dir).catch(() => undefined))?.mtimeMs ?? 0;
		if (now - createdAt > INSPECTION_TTL_MS) await rm(dir, { recursive: true, force: true });
	}
}

function isReservedId(id: string): boolean {
	return CORE_HOOKS.some((hook) => hook.id === id) || BUNDLED_PLUGINS.some((plugin) => plugin.definition.id === id);
}

async function describeReplaced(ctx: CoreContext, id: string): Promise<Inspection["replaces"]> {
	const dir = path.join(ctx.paths.plugins, id);
	if (!existsSync(dir)) return null;
	const config = await readConfig(ctx.paths);
	const json = await readJsonFile(path.join(dir, "plugin.json")).catch(() => undefined);
	const record = await readSourceRecord(dir);
	const version = isRecord(json) && typeof json.version === "string" ? json.version : (record?.version ?? "?");
	return { version, granted: [...(config.grants[id] ?? [])], enabled: !config.disabledPlugins.includes(id) };
}

/**
 * Fetches or copies the package once, hashes it, extracts it to `cache/inspect/<inspectionId>/` and
 * validates it. `installInspected` later installs exactly these bytes; with `expected`, only while that
 * package is still the installed one.
 */
export async function inspectSource(ctx: CoreContext, source: string, opts: { expected?: ExpectedInstall } = {}): Promise<Inspection> {
	const spec = parseSource(source);
	await pruneInspections(ctx);
	const { files, sha256 } = await fetchPackage(spec);
	const pluginJson = files.get("plugin.json");
	if (pluginJson === undefined) throw new BgbError("bad-request", "invalid package: no plugin.json at its root");
	if (pluginJson.byteLength > PACKAGE_JSON_LIMITS.pluginJsonBytes) throw new BgbError("bad-request", "invalid plugin.json: larger than 1 MiB");
	const inspectionId = randomBytes(8).toString("hex");
	const dir = path.join(inspectRoot(ctx), inspectionId);
	const pkgDir = path.join(dir, "pkg");
	try {
		for (const [name, content] of files) {
			const target = path.join(pkgDir, ...name.split("/"));
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, content);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder().decode(pluginJson));
		} catch (error) {
			throw new BgbError("bad-request", `invalid plugin.json: ${errorMessage(error)}`);
		}
		const json = await validatePackage(parsed, pkgDir);
		if (isReservedId(json.id)) throw new BgbError("bad-request", `invalid plugin.json: id "${json.id}" is reserved`);
		const record: InspectionRecord = { source: sourceString(spec), sha256, createdAt: Date.now(), json, ...(opts.expected && { expected: opts.expected }) };
		await writeJsonAtomic(path.join(dir, "inspection.json"), record);
		return { inspectionId, sha256, json, replaces: await describeReplaced(ctx, json.id) };
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

async function takeInspection(ctx: CoreContext, inspectionId: string): Promise<{ dir: string; record: InspectionRecord }> {
	await pruneInspections(ctx);
	const dir = path.join(inspectRoot(ctx), inspectionId);
	const record = INSPECTION_ID.test(inspectionId) ? await readInspectionRecord(dir) : undefined;
	if (record === undefined) throw new BgbError("not-found", `inspection ${inspectionId} is unknown or expired; inspect the plugin again`);
	return { dir, record };
}

/** `not-found` when plugin `id` is gone, `conflict` unless its install record is still `expected`. The caller holds the build lock. */
async function assertInstalled(ctx: CoreContext, id: string, expected: ExpectedInstall): Promise<void> {
	const installed = await readSourceRecord(communityDir(ctx, id));
	if (installed === null || installed.source !== expected.source || installed.sha256 !== expected.sha256 || installed.installedAt !== expected.installedAt) {
		throw new BgbError("conflict", `plugin ${id} was replaced while it was being updated; update it again`);
	}
}

/**
 * Installs the inspection as `plugins/<id>/` and commits `grants[id] = acceptPermissions` (a new id is
 * also enabled), putting the previous package back when the commit fails; then consumes the inspection.
 * `permission-denied` unless `acceptPermissions` covers every requested permission; an update inspection
 * whose package was uninstalled or replaced meanwhile is discarded with `not-found`/`conflict`. The caller
 * holds the build lock; returns the replaced package dir to delete once it is released.
 */
async function commitInspection(
	ctx: CoreContext,
	inspectionId: string,
	acceptPermissions: readonly Permission[],
): Promise<{ id: string; old: string | undefined }> {
	const { dir, record } = await takeInspection(ctx, inspectionId);
	const { json, expected } = record;
	if (expected !== undefined) {
		await assertInstalled(ctx, json.id, expected).catch(async (error: unknown) => {
			await rm(dir, { recursive: true, force: true });
			throw error;
		});
	}
	const accepted = PERMISSIONS.filter((permission) => acceptPermissions.includes(permission));
	const missing = json.permissions.filter((permission) => !accepted.includes(permission));
	if (missing.length > 0) throw new BgbError("permission-denied", `plugin ${json.id} needs permission ${missing.join(", ")}`);

	await mkdir(ctx.paths.plugins, { recursive: true });
	const suffix = randomBytes(6).toString("hex");
	const target = path.join(ctx.paths.plugins, json.id);
	const temp = path.join(ctx.paths.plugins, `.tmp-${suffix}`);
	await rename(path.join(dir, "pkg"), temp);
	const sourceRecord: SourceRecord = { source: record.source, version: json.version, sha256: record.sha256, installedAt: new Date().toISOString() };
	await writeJsonAtomic(path.join(temp, SOURCE_RECORD), sourceRecord);
	const isNew = !existsSync(target);
	const old = path.join(ctx.paths.plugins, `.old-${Date.now()}-${suffix}`);
	if (!isNew) await rename(target, old);
	try {
		await rename(temp, target);
	} catch (error) {
		if (!isNew) await rename(old, target);
		await rm(temp, { recursive: true, force: true });
		throw error;
	}
	try {
		await mutateConfig(ctx.paths, (config) => {
			config.grants[json.id] = accepted;
			if (isNew) config.disabledPlugins = config.disabledPlugins.filter((id) => id !== json.id);
		});
	} catch (error) {
		await rename(target, temp);
		if (!isNew) await rename(old, target);
		await rm(temp, { recursive: true, force: true });
		throw error;
	}
	await rm(dir, { recursive: true, force: true });
	return { id: json.id, old: isNew ? undefined : old };
}

/**
 * Installs exactly the inspected package as `plugins/<id>/` and records `grants[id] = acceptPermissions`.
 * `permission-denied` unless `acceptPermissions` covers every requested permission. A new id is enabled;
 * a replaced id keeps its enabled/disabled state. The swap and the grant commit run under the build lock,
 * so builds and other installs, updates and uninstalls never see one without the other.
 */
export async function installInspected(
	ctx: CoreContext,
	inspectionId: string,
	opts: { acceptPermissions: readonly Permission[] },
): Promise<{ id: string }> {
	const { id, old } = await withLock(ctx.paths, "build", () => commitInspection(ctx, inspectionId, opts.acceptPermissions));
	if (old !== undefined) await rm(old, { recursive: true, force: true });
	return { id };
}

/** `inspectSource` + `installInspected` (`plugins install --yes`, tests). */
export async function installPlugin(
	ctx: CoreContext,
	source: string,
	opts: { acceptPermissions: readonly Permission[] },
): Promise<{ id: string }> {
	const inspection = await inspectSource(ctx, source);
	return installInspected(ctx, inspection.inspectionId, opts);
}

function communityDir(ctx: CoreContext, id: string): string {
	if (isReservedId(id)) throw new BgbError("bad-request", `${id} is not a community plugin`);
	const dir = path.join(ctx.paths.plugins, id);
	if (id.startsWith(".") || id.includes("/") || id.includes("\\") || !existsSync(dir)) {
		throw new BgbError("not-found", `no community plugin ${id}`);
	}
	return dir;
}

/**
 * Removes a community plugin with its grant and disabled flag, under the build lock like installs.
 * Core/bundled → `bad-request`; unknown → `not-found`.
 */
export async function uninstallPlugin(ctx: CoreContext, id: string): Promise<void> {
	const old = await withLock(ctx.paths, "build", async () => {
		const dir = communityDir(ctx, id);
		const old = path.join(ctx.paths.plugins, `.old-${Date.now()}-${randomBytes(6).toString("hex")}`);
		await rename(dir, old);
		try {
			await mutateConfig(ctx.paths, (config) => {
				delete config.grants[id];
				config.disabledPlugins = config.disabledPlugins.filter((disabled) => disabled !== id);
			});
		} catch (error) {
			await rename(old, dir);
			throw error;
		}
		return old;
	});
	await rm(old, { recursive: true, force: true });
}

/**
 * Re-inspects a community plugin's recorded source. Same version and bytes → `current`. Permissions
 * within the current grant → installs it (keeping state and grant) → `updated`. Otherwise installs
 * nothing and returns `needs-consent` with the inspection to confirm through `installInspected`.
 * The grant check and install run under the build lock; `conflict` when the plugin was replaced
 * meanwhile, `not-found` when it was uninstalled.
 */
export async function updatePlugin(ctx: CoreContext, id: string): Promise<PluginUpdateResult> {
	const record = await readSourceRecord(communityDir(ctx, id));
	if (record === null) throw new BgbError("not-found", `plugin ${id} has no install record (${SOURCE_RECORD}); reinstall it`);
	const expected: ExpectedInstall = { source: record.source, sha256: record.sha256, installedAt: record.installedAt };
	const inspection = await inspectSource(ctx, record.source, { expected });
	const discard = (): Promise<void> => rm(path.join(inspectRoot(ctx), inspection.inspectionId), { recursive: true, force: true });
	if (inspection.json.id !== id) {
		await discard();
		throw new BgbError("conflict", `${record.source} now provides plugin ${inspection.json.id}, not ${id}`);
	}
	if (inspection.json.version === record.version && inspection.sha256 === record.sha256) {
		await discard();
		return { state: "current" };
	}
	const { result, old } = await withLock(ctx.paths, "build", async (): Promise<{ result: PluginUpdateResult; old?: string }> => {
		await assertInstalled(ctx, id, expected);
		const granted = (await readConfig(ctx.paths)).grants[id] ?? [];
		const added = inspection.json.permissions.filter((permission) => !granted.includes(permission));
		if (added.length > 0) return { result: { state: "needs-consent", inspectionId: inspection.inspectionId, version: inspection.json.version, added } };
		const { old } = await commitInspection(ctx, inspection.inspectionId, granted);
		return { result: { state: "updated", version: inspection.json.version }, old };
	}).catch(async (error: unknown) => {
		await discard();
		throw error;
	});
	if (old !== undefined) await rm(old, { recursive: true, force: true });
	return result;
}

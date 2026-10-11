/**
 * BGB self-update from GitHub Releases (Step 4.4): check, download + verify, stage/commit the
 * binaries, self-test with rollback, then (agent only) record `update.pending`, start the watchdog
 * from `bin/previous/` and restart.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { unzipSync } from "fflate";
import { type Platform, type UpdateStatus, VERSION_PATTERN } from "../../sdk/index.ts";
import { spawnDetached } from "../agent/restart.ts";
import { readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { withBinariesLock } from "../lock.ts";
import { type CommandRunner, runCommand } from "../services/command.ts";
import { mutateState, readState } from "../state.ts";
import { BGB_COMPILED, BGB_VERSION } from "../version.ts";
import { type FetchFn, fetchBytes, githubHeaders, sha256Hex } from "./download.ts";

const REPO = "Unravl/better-grok-bot";

/** `core/setup/binaries.ts` (slice S9). */
export interface BinaryOps {
	stageBinaries(ctx: CoreContext, srcDir: string, expectedVersion: string): Promise<string>;
	commitBinaries(ctx: CoreContext, stagedDir: string): Promise<void>;
	restorePrevious(ctx: CoreContext): Promise<void>;
}

export interface UpdateDeps {
	/** Self-update only runs inside the compiled binary. */
	compiled: boolean;
	fetch: FetchFn;
	arch: string;
	run: CommandRunner;
	binaries(): Promise<BinaryOps>;
	spawnDetached(argv: readonly string[], env: Record<string, string>): void;
	/** Watchdog `/health` poll interval. */
	pollMs: number;
}

function resolveDeps(ctx: CoreContext, overrides: Partial<UpdateDeps> = {}): UpdateDeps {
	return {
		compiled: BGB_COMPILED,
		fetch,
		arch: process.arch,
		run: runCommand,
		binaries: async () => {
			// Lazy so tests inject fakes instead of replacing slice S9's module process-wide (bun's mock.module leaks).
			const module = await import("../setup/binaries.ts");
			return {
				stageBinaries: module.stageBinaries,
				commitBinaries: module.commitBinaries,
				restorePrevious: module.restorePrevious,
			};
		},
		spawnDetached: (argv, env) => spawnDetached(argv, env, ctx.log),
		pollMs: 2_000,
		...overrides,
	};
}

/** Semver precedence: negative when `a < b`. Prereleases sort before their release. */
export function compareVersions(a: string, b: string): number {
	const parse = (version: string): { core: number[]; pre: string[] } => {
		if (!VERSION_PATTERN.test(version)) throw new Error(`not a version: ${version}`);
		const [core = "", pre] = version.split(/-(.*)/s, 2);
		return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) {
		const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0);
		if (diff !== 0) return diff;
	}
	if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
		if (p === q) continue;
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		if (pn && qn) return Number(p) - Number(q);
		if (pn !== qn) return pn ? -1 : 1;
		return p < q ? -1 : 1;
	}
	return 0;
}

/** Release asset holding the binaries for an OS/arch. */
export function updateAssetName(platform: Platform, arch: string): string {
	if (arch !== "x64" && arch !== "arm64") throw new Error(`no Better Grok Bot build for ${arch}`);
	return platform === "win32" ? `bgb-windows-${arch}.zip` : `bgb-${platform}-${arch}.tar.gz`;
}

/** `SHA256SUMS` lines (`<hex>  <name>` or `<hex> *<name>`) → name → lowercase hex. */
export function parseSha256Sums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
		if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
	}
	return sums;
}

async function latestRelease(fetchFn: FetchFn): Promise<{ tag: string; version: string }> {
	const response = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, {
		headers: githubHeaders(),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for the latest release`);
	const body: unknown = await response.json();
	const tag = typeof body === "object" && body !== null && "tag_name" in body ? body.tag_name : undefined;
	const version = typeof tag === "string" && tag.startsWith("v") ? tag.slice(1) : "";
	if (typeof tag !== "string" || !VERSION_PATTERN.test(version)) throw new Error(`latest release tag ${String(tag)} is not vX.Y.Z`);
	return { tag, version };
}

/** Asks GitHub for the latest release and records `update.checkedAt`/`latest`. `disabled` outside the compiled binary. */
export async function checkForUpdate(ctx: CoreContext, overrides: Partial<UpdateDeps> = {}): Promise<UpdateStatus> {
	const deps = resolveDeps(ctx, overrides);
	if (!deps.compiled) return { state: "disabled", current: BGB_VERSION };
	const checkedAt = new Date().toISOString();
	try {
		const { version } = await latestRelease(deps.fetch);
		await mutateState(ctx.paths, (state) => {
			state.update.checkedAt = checkedAt;
			state.update.latest = version;
		});
		return { state: compareVersions(version, BGB_VERSION) > 0 ? "available" : "idle", current: BGB_VERSION, latest: version };
	} catch (error) {
		await mutateState(ctx.paths, (state) => {
			state.update.checkedAt = checkedAt;
		});
		return { state: "error", current: BGB_VERSION, error: `update check failed: ${errorMessage(error)}` };
	}
}

export interface ApplyUpdateOptions {
	/** Agent only: record `update.pending`, start the watchdog from `bin/previous/`, then call {@link restart}. */
	restartAgent: boolean;
	/** The agent's restart rule (graceful shutdown, then launchd or `agent --replace`). */
	restart?: () => void | Promise<void>;
	/** Progress (`downloading`). */
	onStatus?: (status: UpdateStatus) => void;
	deps?: Partial<UpdateDeps>;
}

async function extractArchive(
	asset: string,
	bytes: Uint8Array,
	workDir: string,
	outDir: string,
	run: CommandRunner,
): Promise<void> {
	await mkdir(outDir, { recursive: true });
	if (asset.endsWith(".zip")) {
		const entries = unzipSync(bytes);
		for (const [name, data] of Object.entries(entries)) {
			if (name !== "bgb.exe" && name !== "bgbw.exe") continue;
			await writeFile(path.join(outDir, name), data);
		}
	} else {
		const archive = path.join(workDir, asset);
		await writeFile(archive, bytes);
		const result = await run(["tar", "-xzf", archive, "-C", outDir], { timeoutMs: 120_000 });
		if (result.code !== 0) throw new Error(`tar -xzf failed: ${result.stderr.trim() || result.code}`);
	}
}

/**
 * Installs the latest release over `DATA/bin`: download + verify against `SHA256SUMS` (nothing in
 * `bin/` changes before that passes), extract, stage, commit, and run `bin/bgb agent --self-test`;
 * a failing self-test restores `bin/previous/`. Failures are recorded in `state.update.error` and
 * returned as `{state:"error"}`. Everything from the download to `update.pending` runs under the
 * `binaries` lock; while another install or update holds it, throws `BgbError("conflict")` and
 * changes nothing.
 */
export async function applyUpdate(ctx: CoreContext, opts: ApplyUpdateOptions): Promise<UpdateStatus> {
	const deps = resolveDeps(ctx, opts.deps);
	if (!deps.compiled) return { state: "disabled", current: BGB_VERSION };
	let release: { tag: string; version: string };
	try {
		release = await latestRelease(deps.fetch);
	} catch (error) {
		return { state: "error", current: BGB_VERSION, error: `update check failed: ${errorMessage(error)}` };
	}
	const { tag, version } = release;
	if (compareVersions(version, BGB_VERSION) <= 0) return { state: "idle", current: BGB_VERSION, latest: version };

	const fail = async (message: string): Promise<UpdateStatus> => {
		ctx.log.error(`update: ${message}`);
		await mutateState(ctx.paths, (state) => {
			state.update.error = message;
		});
		return { state: "error", current: BGB_VERSION, latest: version, error: message };
	};

	// One transaction over `bin/` at a time: a second update (another request, the 6-hourly tick, or a
	// `bgb update` in another process) would discard the `previous/` this one's rollback depends on.
	const failed = await withBinariesLock(ctx.paths, async (): Promise<UpdateStatus | null> => {
		opts.onStatus?.({ state: "downloading", current: BGB_VERSION, latest: version });
		let asset: string;
		let bytes: Uint8Array;
		try {
			asset = updateAssetName(ctx.platform.id, deps.arch);
			const base = `https://github.com/${REPO}/releases/download/${tag}`;
			const sumsText = new TextDecoder().decode(
				await fetchBytes(deps.fetch, `${base}/SHA256SUMS`, { timeoutMs: 30_000, maxBytes: 1024 * 1024 }),
			);
			const expected = parseSha256Sums(sumsText).get(asset);
			if (!expected) throw new Error(`SHA256SUMS of ${tag} lists no ${asset}`);
			bytes = await fetchBytes(deps.fetch, `${base}/${asset}`, { timeoutMs: 600_000, maxBytes: 300 * 1024 * 1024 });
			if (sha256Hex(bytes) !== expected) throw new Error(`checksum mismatch for ${asset}`);
		} catch (error) {
			return fail(`${version} download failed: ${errorMessage(error)}`);
		}

		const binaries = await deps.binaries();
		const workDir = path.join(ctx.paths.bin, `.download-${randomBytes(6).toString("hex")}`);
		try {
			const extracted = path.join(workDir, "extracted");
			await extractArchive(asset, bytes, workDir, extracted, deps.run);
			if (!existsSync(path.join(extracted, ctx.platform.binName()))) throw new Error(`${asset} has no ${ctx.platform.binName()}`);
			const staged = await binaries.stageBinaries(ctx, extracted, version);
			await binaries.commitBinaries(ctx, staged);
		} catch (error) {
			return fail(`${version} could not be installed: ${errorMessage(error)}`);
		} finally {
			await rm(workDir, { recursive: true, force: true });
		}

		const selfTest = await deps.run([path.join(ctx.paths.bin, ctx.platform.binName()), "agent", "--self-test"], {
			timeoutMs: 30_000,
			env: { BGB_DATA_DIR: ctx.paths.root },
		});
		if (selfTest.code !== 0 || !selfTest.stdout.includes(`ok ${version}`)) {
			ctx.log.error(`update: ${version} self-test output: ${(selfTest.stderr || selfTest.stdout).trim()}`);
			try {
				await binaries.restorePrevious(ctx);
			} catch (error) {
				ctx.log.error(`update: restoring the previous binaries failed: ${errorMessage(error)}`);
			}
			return fail(`${version} failed its self-test`);
		}

		await mutateState(ctx.paths, (state) => {
			state.update.error = null;
			state.update.latest = version;
			if (opts.restartAgent) state.update.pending = { version, previous: BGB_VERSION, at: new Date().toISOString() };
		});
		return null;
	});
	if (failed !== null) return failed;
	ctx.log.info(`update: installed ${version} (was ${BGB_VERSION})`);
	if (opts.restartAgent) {
		const watchdog = path.join(ctx.paths.binPrevious, ctx.platform.binName());
		deps.spawnDetached([watchdog, "update-watchdog", "--expect", version, "--timeout", "90"], { BGB_DATA_DIR: ctx.paths.root });
		await opts.restart?.();
	}
	return { state: "installed", current: BGB_VERSION, latest: version };
}

/**
 * `bgb update-watchdog` (run from `bin/previous/`): waits for an agent of `expect` on `/health`. When
 * none answers within `timeoutS`, stops whatever runs, restores `bin/previous/`, records the error,
 * starts the restored agent and notifies. Exits 0 either way.
 */
export async function runUpdateWatchdog(
	ctx: CoreContext,
	opts: { expect: string; timeoutS: number },
	overrides: Partial<UpdateDeps> = {},
): Promise<number> {
	const deps = resolveDeps(ctx, overrides);
	const deadline = Date.now() + opts.timeoutS * 1000;
	for (;;) {
		const config = await readConfig(ctx.paths).catch(() => null);
		if (config) {
			try {
				const response = await deps.fetch(`http://127.0.0.1:${config.bridgePort}/health`, {
					signal: AbortSignal.timeout(1_500),
				});
				const body: unknown = await response.json();
				if (typeof body === "object" && body !== null && "version" in body && body.version === opts.expect) {
					ctx.log.info(`update-watchdog: ${opts.expect} is healthy`);
					return 0;
				}
			} catch {
				// Not up yet.
			}
		}
		if (Date.now() >= deadline) break;
		await Bun.sleep(Math.min(deps.pollMs, Math.max(0, deadline - Date.now())));
	}

	const previous = (await readState(ctx.paths)).update.pending?.previous ?? "the previous version";
	ctx.log.error(`update-watchdog: ${opts.expect} did not become healthy within ${opts.timeoutS} s; restoring ${previous}`);
	await ctx.platform.stopAgent(ctx.paths).catch((error) => ctx.log.error(`update-watchdog: stop: ${errorMessage(error)}`));
	try {
		await (await deps.binaries()).restorePrevious(ctx);
	} catch (error) {
		ctx.log.error(`update-watchdog: restoring ${previous} failed: ${errorMessage(error)}`);
	}
	await mutateState(ctx.paths, (state) => {
		state.update.pending = null;
		state.update.error = `${opts.expect} failed to start; restored ${previous}`;
	});
	await ctx.platform
		.startAgent(path.join(ctx.paths.bin, ctx.platform.binName()), ctx.paths)
		.catch((error) => ctx.log.error(`update-watchdog: start: ${errorMessage(error)}`));
	await ctx.platform.notify("Better Grok Bot", `Update to ${opts.expect} failed; restored ${previous}`);
	return 0;
}

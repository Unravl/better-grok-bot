import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type FakePlatform, fakePlatform, tempContext } from "../agent/testing.ts";
import { mutateConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { withBinariesLock } from "../lock.ts";
import { runCommand } from "../services/command.ts";
import { mutateState, readState } from "../state.ts";
import { BGB_VERSION } from "../version.ts";
import { sha256Hex } from "./download.ts";
import {
	type BinaryOps,
	applyUpdate,
	checkForUpdate,
	compareVersions,
	parseSha256Sums,
	runUpdateWatchdog,
	updateAssetName,
} from "./self-update.ts";

const NEW = "9.9.9";
const posix = process.platform !== "win32";
let ctx: CoreContext & { cleanup(): Promise<void> };
let platform: FakePlatform;
let work: string;

beforeEach(async () => {
	platform = fakePlatform("linux");
	ctx = await tempContext(platform);
	work = await mkdtemp(path.join(tmpdir(), "bgb-update-work-"));
	await mkdir(ctx.paths.bin, { recursive: true });
});

afterEach(async () => {
	await ctx.cleanup();
	await rm(work, { recursive: true, force: true });
});

function script(version: string, selfTestOk: boolean): string {
	return [
		"#!/bin/sh",
		`if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi`,
		`if [ "$1" = "agent" ] && [ "$2" = "--self-test" ]; then ${selfTestOk ? `echo "ok ${version}"; exit 0` : "echo broken >&2; exit 1"}; fi`,
		"exit 2",
		"",
	].join("\n");
}

async function writeExecutable(file: string, text: string): Promise<void> {
	await writeFile(file, text);
	await chmod(file, 0o755);
}

/** A faithful-enough stand-in for slice S9's binaries transaction (stage, commit into previous/, restore). */
function fakeBinaries(calls: string[]): () => Promise<BinaryOps> {
	const ops: BinaryOps = {
		async stageBinaries(c, srcDir, expectedVersion) {
			calls.push("stage");
			const staged = path.join(c.paths.bin, ".staged-test");
			await mkdir(staged, { recursive: true });
			await copyFile(path.join(srcDir, "bgb"), path.join(staged, "bgb"));
			await chmod(path.join(staged, "bgb"), 0o755);
			const version = (await runCommand([path.join(staged, "bgb"), "--version"])).stdout.trim();
			if (version !== expectedVersion) throw new Error(`staged ${version}, expected ${expectedVersion}`);
			return staged;
		},
		async commitBinaries(c, staged) {
			calls.push("commit");
			await rm(c.paths.binPrevious, { recursive: true, force: true });
			await mkdir(c.paths.binPrevious, { recursive: true });
			await rename(path.join(c.paths.bin, "bgb"), path.join(c.paths.binPrevious, "bgb"));
			await rename(path.join(staged, "bgb"), path.join(c.paths.bin, "bgb"));
			await rm(staged, { recursive: true, force: true });
		},
		async restorePrevious(c) {
			calls.push("restore");
			await rename(path.join(c.paths.binPrevious, "bgb"), path.join(c.paths.bin, "bgb"));
		},
	};
	return async () => ops;
}

/** Serves the GitHub API + release downloads for one release. */
function releaseFetch(files: Record<string, Uint8Array<ArrayBuffer> | string>, tag = `v${NEW}`) {
	const requested: string[] = [];
	const fetchFn = async (input: string | URL | Request): Promise<Response> => {
		const url = String(input);
		requested.push(url);
		if (url === "https://api.github.com/repos/Unravl/better-grok-bot/releases/latest") return Response.json({ tag_name: tag });
		const prefix = `https://github.com/Unravl/better-grok-bot/releases/download/${tag}/`;
		const body = url.startsWith(prefix) ? files[url.slice(prefix.length)] : undefined;
		return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
	};
	return { fetchFn, requested };
}

async function tarball(binScript: string): Promise<Uint8Array<ArrayBuffer>> {
	const src = path.join(work, `src-${Math.random().toString(36).slice(2)}`);
	await mkdir(src, { recursive: true });
	await writeExecutable(path.join(src, "bgb"), binScript);
	const archive = path.join(work, "bgb-linux-x64.tar.gz");
	const result = await runCommand(["tar", "-czf", archive, "-C", src, "bgb"]);
	if (result.code !== 0) throw new Error(result.stderr);
	return new Uint8Array(await readFile(archive));
}

test("version helpers", () => {
	expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
	expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
	expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBeLessThan(0);
	expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
	expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
	expect(updateAssetName("darwin", "arm64")).toBe("bgb-darwin-arm64.tar.gz");
	expect(updateAssetName("linux", "x64")).toBe("bgb-linux-x64.tar.gz");
	expect(updateAssetName("win32", "arm64")).toBe("bgb-windows-arm64.zip");
	const sums = parseSha256Sums(`${"A".repeat(64)}  bgb-linux-x64.tar.gz\n${"b".repeat(64)} *bgb-windows-x64.zip\njunk\n`);
	expect([...sums]).toEqual([
		["bgb-linux-x64.tar.gz", "a".repeat(64)],
		["bgb-windows-x64.zip", "b".repeat(64)],
	]);
});

test("checkForUpdate is disabled outside the compiled binary and compares the latest tag", async () => {
	expect(await checkForUpdate(ctx)).toEqual({ state: "disabled", current: BGB_VERSION });
	const newer = releaseFetch({});
	expect(await checkForUpdate(ctx, { compiled: true, fetch: newer.fetchFn })).toEqual({
		state: "available",
		current: BGB_VERSION,
		latest: NEW,
	});
	expect((await readState(ctx.paths)).update.latest).toBe(NEW);
	const same = releaseFetch({}, `v${BGB_VERSION}`);
	expect((await checkForUpdate(ctx, { compiled: true, fetch: same.fetchFn })).state).toBe("idle");
	const broken = releaseFetch({}, "nightly");
	expect((await checkForUpdate(ctx, { compiled: true, fetch: broken.fetchFn })).state).toBe("error");
});

test("a checksum mismatch aborts before anything in bin/ changes", async () => {
	await writeFile(path.join(ctx.paths.bin, "bgb"), "old");
	const before = await readdir(ctx.paths.bin);
	const archive = new TextEncoder().encode("archive bytes");
	const { fetchFn, requested } = releaseFetch({
		"bgb-linux-x64.tar.gz": archive,
		SHA256SUMS: `${"0".repeat(64)}  bgb-linux-x64.tar.gz\n`,
	});
	const calls: string[] = [];
	const status = await applyUpdate(ctx, {
		restartAgent: false,
		deps: { compiled: true, fetch: fetchFn, arch: "x64", binaries: fakeBinaries(calls) },
	});
	expect(status.state).toBe("error");
	expect(status.error).toContain("checksum mismatch for bgb-linux-x64.tar.gz");
	expect(calls).toEqual([]);
	expect(requested).toEqual([
		"https://api.github.com/repos/Unravl/better-grok-bot/releases/latest",
		`https://github.com/Unravl/better-grok-bot/releases/download/v${NEW}/SHA256SUMS`,
		`https://github.com/Unravl/better-grok-bot/releases/download/v${NEW}/bgb-linux-x64.tar.gz`,
	]);
	expect(await readdir(ctx.paths.bin)).toEqual(before);
	expect(await readFile(path.join(ctx.paths.bin, "bgb"), "utf8")).toBe("old");
	expect((await readState(ctx.paths)).update.error).toContain("checksum mismatch");
});

test("while another transaction holds the binaries lock, applyUpdate throws conflict and downloads nothing", async () => {
	await writeFile(path.join(ctx.paths.bin, "bgb"), "old");
	const { fetchFn, requested } = releaseFetch({});
	const calls: string[] = [];
	const holding = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const other = withBinariesLock(ctx.paths, async () => {
		holding.resolve();
		await finish.promise;
	});
	await holding.promise;
	try {
		await expect(
			applyUpdate(ctx, { restartAgent: false, deps: { compiled: true, fetch: fetchFn, arch: "x64", binaries: fakeBinaries(calls) } }),
		).rejects.toMatchObject({ code: "conflict" });
	} finally {
		finish.resolve();
		await other;
	}
	expect(calls).toEqual([]);
	expect(requested).toEqual(["https://api.github.com/repos/Unravl/better-grok-bot/releases/latest"]);
	expect(await readFile(path.join(ctx.paths.bin, "bgb"), "utf8")).toBe("old");
	expect((await readState(ctx.paths)).update.error).toBeNull();
});

test.skipIf(!posix)("a new binary failing its self-test is rolled back", async () => {
	await writeExecutable(path.join(ctx.paths.bin, "bgb"), script("0.1.0", true));
	const archive = await tarball(script(NEW, false));
	const { fetchFn } = releaseFetch({
		"bgb-linux-x64.tar.gz": archive,
		SHA256SUMS: `${sha256Hex(archive)}  bgb-linux-x64.tar.gz\n`,
	});
	const calls: string[] = [];
	const spawned: string[][] = [];
	const status = await applyUpdate(ctx, {
		restartAgent: true,
		restart: () => {
			calls.push("restart");
		},
		deps: {
			compiled: true,
			fetch: fetchFn,
			arch: "x64",
			binaries: fakeBinaries(calls),
			spawnDetached: (argv) => spawned.push([...argv]),
		},
	});
	expect(status).toEqual({ state: "error", current: BGB_VERSION, latest: NEW, error: `${NEW} failed its self-test` });
	expect(calls).toEqual(["stage", "commit", "restore"]);
	expect(spawned).toEqual([]);
	expect((await runCommand([path.join(ctx.paths.bin, "bgb"), "--version"])).stdout.trim()).toBe("0.1.0");
	const state = await readState(ctx.paths);
	expect(state.update.error).toBe(`${NEW} failed its self-test`);
	expect(state.update.pending).toBeNull();
	expect((await readdir(ctx.paths.bin)).filter((entry) => entry.startsWith(".download-"))).toEqual([]);
});

test.skipIf(!posix)("a healthy update records pending, starts the watchdog from previous/ and restarts", async () => {
	await writeExecutable(path.join(ctx.paths.bin, "bgb"), script("0.1.0", true));
	const archive = await tarball(script(NEW, true));
	const { fetchFn } = releaseFetch({
		"bgb-linux-x64.tar.gz": archive,
		SHA256SUMS: `${sha256Hex(archive)}  bgb-linux-x64.tar.gz\n`,
	});
	const calls: string[] = [];
	const spawned: { argv: string[]; env: Record<string, string> }[] = [];
	const statuses: string[] = [];
	const status = await applyUpdate(ctx, {
		restartAgent: true,
		restart: () => {
			calls.push("restart");
		},
		onStatus: (s) => statuses.push(s.state),
		deps: {
			compiled: true,
			fetch: fetchFn,
			arch: "x64",
			binaries: fakeBinaries(calls),
			spawnDetached: (argv, env) => spawned.push({ argv: [...argv], env }),
		},
	});
	expect(status).toEqual({ state: "installed", current: BGB_VERSION, latest: NEW });
	expect(statuses).toEqual(["downloading"]);
	expect(calls).toEqual(["stage", "commit", "restart"]);
	expect(spawned).toEqual([
		{
			argv: [path.join(ctx.paths.binPrevious, "bgb"), "update-watchdog", "--expect", NEW, "--timeout", "90"],
			env: { BGB_DATA_DIR: ctx.paths.root },
		},
	]);
	expect((await runCommand([path.join(ctx.paths.bin, "bgb"), "--version"])).stdout.trim()).toBe(NEW);
	const pending = (await readState(ctx.paths)).update.pending;
	expect(pending?.version).toBe(NEW);
	expect(pending?.previous).toBe(BGB_VERSION);
});

async function healthServer(version: string) {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ name: "better-grok-bot", version, pid: process.pid }),
	});
}

test("the watchdog restores previous/ when the expected version never reports healthy", async () => {
	const server = await healthServer("0.1.0");
	try {
		await mutateConfig(ctx.paths, (config) => {
			config.bridgePort = server.port ?? 0;
		});
		await mutateState(ctx.paths, (state) => {
			state.update.pending = { version: NEW, previous: "0.1.0", at: new Date().toISOString() };
		});
		const calls: string[] = [];
		const restore: () => Promise<BinaryOps> = async () => ({
			stageBinaries: async () => "",
			commitBinaries: async () => {},
			restorePrevious: async () => {
				calls.push("restore");
			},
		});
		expect(await runUpdateWatchdog(ctx, { expect: NEW, timeoutS: 0.3 }, { pollMs: 50, binaries: restore })).toBe(0);
		expect(calls).toEqual(["restore"]);
		expect(platform.calls).toEqual(["stopAgent", "startAgent", `notify:Update to ${NEW} failed; restored 0.1.0`]);
		const state = await readState(ctx.paths);
		expect(state.update.pending).toBeNull();
		expect(state.update.error).toBe(`${NEW} failed to start; restored 0.1.0`);
	} finally {
		server.stop(true);
	}
});

test("the watchdog exits quietly once the expected version is healthy", async () => {
	const server = await healthServer(NEW);
	try {
		await mutateConfig(ctx.paths, (config) => {
			config.bridgePort = server.port ?? 0;
		});
		const calls: string[] = [];
		const binaries: () => Promise<BinaryOps> = async () => {
			calls.push("loaded");
			throw new Error("must not be used");
		};
		expect(await runUpdateWatchdog(ctx, { expect: NEW, timeoutS: 5 }, { pollMs: 50, binaries })).toBe(0);
		expect(calls).toEqual([]);
		expect(platform.calls).toEqual([]);
	} finally {
		server.stop(true);
	}
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Platform } from "../../sdk/index.ts";
import { type CoreContext, createContext } from "../context.ts";
import { nullLogger } from "../log.ts";
import { type BinariesIo, commitBinaries, restorePrevious, stageBinaries, systemBinariesIo } from "./binaries.ts";
import { recordingAdapter } from "./test-fakes.ts";

const isWindows = process.platform === "win32";
const NAMES = isWindows ? ["bgb.exe", "bgbw.exe"] : ["bgb"];
const MAIN = NAMES[0] ?? "bgb";

let root: string;
let ctx: CoreContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "bgb-binaries-"));
	ctx = await createContext({ dataDir: path.join(root, "data"), platform: recordingAdapter([]), log: nullLogger });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** A dir holding copies of the running Bun as the install's binaries (`bun --version` = `Bun.version`). */
async function fakeRelease(name: string): Promise<string> {
	const dir = path.join(root, name);
	await mkdir(dir, { recursive: true });
	for (const file of NAMES) await copyFile(process.execPath, path.join(dir, file));
	return dir;
}

/** Installs a first set of binaries into `DATA/bin` and returns the CLI's inode. */
async function installOld(): Promise<number> {
	await commitBinaries(ctx, await stageBinaries(ctx, await fakeRelease("old"), Bun.version));
	return (await stat(path.join(ctx.paths.bin, MAIN))).ino;
}

async function installedVersion(): Promise<string> {
	const proc = Bun.spawn([path.join(ctx.paths.bin, MAIN), "--version"], { stdout: "pipe", stderr: "ignore" });
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	expect(code).toBe(0);
	return out.trim();
}

/** Real io whose `rename` throws on its `failAt`-th call. */
function failingRename(failAt: number): BinariesIo {
	let calls = 0;
	return {
		...systemBinariesIo,
		rename: async (from, to) => {
			calls++;
			if (calls === failAt) throw new Error(`injected failure at move ${failAt}`);
			await systemBinariesIo.rename(from, to);
		},
	};
}

async function binEntries(): Promise<string[]> {
	return (await readdir(ctx.paths.bin)).toSorted();
}

test("stage + commit installs the binaries and keeps the replaced ones in previous/", async () => {
	const oldIno = await installOld();
	expect(await binEntries()).toEqual(NAMES.toSorted());

	const staged = await stageBinaries(ctx, await fakeRelease("new"), Bun.version);
	expect(path.basename(staged).startsWith(".staged-")).toBe(true);
	await commitBinaries(ctx, staged);

	expect(existsSync(staged)).toBe(false);
	expect(await installedVersion()).toBe(Bun.version);
	expect((await stat(path.join(ctx.paths.binPrevious, MAIN))).ino).toBe(oldIno);
	expect((await stat(path.join(ctx.paths.bin, MAIN))).ino).not.toBe(oldIno);
});

test("stageBinaries rejects a binary reporting another version and leaves no staging dir", async () => {
	const src = await fakeRelease("new");
	await expect(stageBinaries(ctx, src, "0.0.0-not-this")).rejects.toThrow(/reports version ".*", expected 0\.0\.0-not-this/);
	expect(existsSync(ctx.paths.bin) ? await binEntries() : []).toEqual([]);
});

test("stageBinaries on Windows requires bgbw.exe next to bgb.exe", async () => {
	const winCtx = await createContext({
		dataDir: path.join(root, "win-data"),
		platform: recordingAdapter([], { id: "win32" as Platform }),
		log: nullLogger,
	});
	const src = path.join(root, "win-src");
	await mkdir(src);
	await copyFile(process.execPath, path.join(src, "bgb.exe"));
	await expect(stageBinaries(winCtx, src, Bun.version)).rejects.toThrow("bgbw.exe must be next to bgb.exe");
});

for (let failAt = 1; failAt <= NAMES.length * 2; failAt++) {
	test(`a commit failing at move ${failAt} rolls back and the old bgb still runs`, async () => {
		const oldIno = await installOld();
		const staged = await stageBinaries(ctx, await fakeRelease("new"), Bun.version);

		await expect(commitBinaries(ctx, staged, failingRename(failAt))).rejects.toThrow(`injected failure at move ${failAt}`);

		expect((await stat(path.join(ctx.paths.bin, MAIN))).ino).toBe(oldIno);
		expect(await installedVersion()).toBe(Bun.version);
		expect(existsSync(staged)).toBe(false);
		expect(existsSync(path.join(ctx.paths.binPrevious, MAIN))).toBe(false);
	});
}

test("a commit whose installed bgb reports the wrong version restores the previous binaries", async () => {
	const oldIno = await installOld();
	const staged = await stageBinaries(ctx, await fakeRelease("new"), Bun.version);
	const installed = path.join(ctx.paths.bin, MAIN);
	const io: BinariesIo = {
		...systemBinariesIo,
		exec: async (argv) => (argv[0] === installed ? { code: 0, stdout: "9.9.9\n", stderr: "" } : systemBinariesIo.exec(argv)),
	};

	await expect(commitBinaries(ctx, staged, io)).rejects.toThrow(/reports "9\.9\.9", expected .*restored the previous binaries/);

	expect((await stat(installed)).ino).toBe(oldIno);
	expect(await installedVersion()).toBe(Bun.version);
	expect((await binEntries()).filter((entry) => !entry.startsWith(".trash-"))).toEqual(NAMES.toSorted());
});

test("restorePrevious puts the replaced binaries back", async () => {
	const oldIno = await installOld();
	await commitBinaries(ctx, await stageBinaries(ctx, await fakeRelease("new"), Bun.version));

	await restorePrevious(ctx);

	expect((await stat(path.join(ctx.paths.bin, MAIN))).ino).toBe(oldIno);
	expect(existsSync(ctx.paths.binPrevious)).toBe(false);
	expect(await installedVersion()).toBe(Bun.version);
});

for (let failAt = 1; failAt <= NAMES.length * 2; failAt++) {
	test(`restorePrevious failing at move ${failAt} keeps the current bgb running`, async () => {
		await installOld();
		await commitBinaries(ctx, await stageBinaries(ctx, await fakeRelease("new"), Bun.version));
		const newIno = (await stat(path.join(ctx.paths.bin, MAIN))).ino;

		await expect(restorePrevious(ctx, failingRename(failAt))).rejects.toThrow(`injected failure at move ${failAt}`);

		expect((await stat(path.join(ctx.paths.bin, MAIN))).ino).toBe(newIno);
		expect(existsSync(path.join(ctx.paths.binPrevious, MAIN))).toBe(true);
		expect(await installedVersion()).toBe(Bun.version);
	});
}

test("restorePrevious refuses to run without previous binaries", async () => {
	await installOld();
	await expect(restorePrevious(ctx)).rejects.toThrow("no previous Better Grok Bot binaries");
	expect(await installedVersion()).toBe(Bun.version);
});

test.skipIf(!isWindows)("commit succeeds while the installed bgb.exe is running, twice", async () => {
	await installOld();
	const running = Bun.spawn([path.join(ctx.paths.bin, "bgb.exe"), "-e", "setTimeout(()=>{},60000)"], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	try {
		// CreateProcess has mapped the image once spawn returns, so the exe is already locked.
		await commitBinaries(ctx, await stageBinaries(ctx, await fakeRelease("new"), Bun.version));
		expect(await installedVersion()).toBe(Bun.version);
		// The running exe now sits in previous/, which the next commit must clear out of the way.
		await commitBinaries(ctx, await stageBinaries(ctx, await fakeRelease("newer"), Bun.version));
		expect(await installedVersion()).toBe(Bun.version);
	} finally {
		running.kill();
		await running.exited;
	}
});

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { renameReplacing } from "../json-file.ts";
import { withBinariesLock } from "../lock.ts";
import { type ExecResult, execCommand } from "./host.ts";

/** File-moving and process seams of the binary transaction; tests inject failures here. */
export interface BinariesIo {
	rename(from: string, to: string): Promise<void>;
	exec(argv: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;
}

export const systemBinariesIo: BinariesIo = { rename: renameReplacing, exec: execCommand };

/** Written into a staging dir by {@link stageBinaries}: the version `commitBinaries` must find installed. */
const STAGED_VERSION_FILE = ".version";

/** A failed transaction whose rollback could not move everything back. */
class RollbackFailedError extends Error {}

/** The files of one install: `bgb`, or `bgb.exe` + `bgbw.exe` on Windows. The first is the CLI. */
function binaryNames(ctx: CoreContext): [string, ...string[]] {
	const main = ctx.platform.binName();
	return ctx.platform.id === "win32" ? [main, "bgbw.exe"] : [main];
}

/** Random suffix for `bin/.staged-*` and `bin/.trash-*`. */
function uniqueSuffix(): string {
	return randomBytes(6).toString("hex");
}

async function readVersion(io: BinariesIo, bin: string): Promise<string> {
	const result = await io.exec([bin, "--version"], { timeoutMs: 30_000 });
	if (result.code !== 0) {
		throw new Error(`${bin} --version exited with ${result.code}: ${(result.stderr || result.stdout).trim() || "no output"}`);
	}
	return result.stdout.trim();
}

/**
 * Runs `fn` with a `move` that journals each rename. If `fn` throws, moves everything back (newest first)
 * and rethrows; a rollback that leaves files behind throws {@link RollbackFailedError} naming them.
 */
async function moveTransaction(io: BinariesIo, fn: (move: (from: string, to: string) => Promise<void>) => Promise<void>): Promise<void> {
	const moves: { from: string; to: string }[] = [];
	try {
		await fn(async (from, to) => {
			await io.rename(from, to);
			moves.push({ from, to });
		});
	} catch (error) {
		const stuck: string[] = [];
		for (const { from, to } of moves.toReversed()) {
			try {
				await io.rename(to, from);
			} catch (moveError) {
				stuck.push(`${to} → ${from}: ${errorMessage(moveError)}`);
			}
		}
		if (stuck.length > 0) throw new RollbackFailedError(`${errorMessage(error)}; could not move back ${stuck.join("; ")}`);
		throw error;
	}
}

/**
 * Copies `bgb[.exe]` (and `bgbw.exe` on Windows) from `srcDir` into a new `bin/.staged-*` dir, makes
 * them executable, clears the macOS quarantine flag, and checks that the staged CLI reports
 * `expectedVersion`. Returns the staging dir; on any failure deletes it and throws.
 */
export async function stageBinaries(
	ctx: CoreContext,
	srcDir: string,
	expectedVersion: string,
	io: BinariesIo = systemBinariesIo,
): Promise<string> {
	const names = binaryNames(ctx);
	for (const name of names) {
		if (existsSync(path.join(srcDir, name))) continue;
		throw new Error(name === "bgbw.exe" ? "bgbw.exe must be next to bgb.exe" : `${path.join(srcDir, name)} not found`);
	}
	await mkdir(ctx.paths.bin, { recursive: true });
	const staged = path.join(ctx.paths.bin, `.staged-${uniqueSuffix()}`);
	await mkdir(staged);
	try {
		for (const name of names) {
			const file = path.join(staged, name);
			await copyFile(path.join(srcDir, name), file);
			if (process.platform !== "win32") await chmod(file, 0o755);
			if (ctx.platform.id === "darwin") {
				// Fails when the attribute is absent; only a downloaded copy carries it.
				await io.exec(["xattr", "-d", "com.apple.quarantine", file]).catch(() => undefined);
			}
		}
		const version = await readVersion(io, path.join(staged, names[0]));
		if (version !== expectedVersion) {
			throw new Error(`the new bgb reports version "${version}", expected ${expectedVersion}`);
		}
		await writeFile(path.join(staged, STAGED_VERSION_FILE), version);
		return staged;
	} catch (error) {
		await rm(staged, { recursive: true, force: true });
		throw error;
	}
}

/**
 * Empties the way for a new `bin/previous/`: deletes the old one, or, when a file in it can't be deleted
 * (Windows: a previous exe still running, such as an update watchdog), moves it into `bin/.trash-*`. A
 * running exe can be renamed but not deleted, so the last resort moves its entries one by one.
 */
async function discardPrevious(ctx: CoreContext, io: BinariesIo): Promise<void> {
	const previous = ctx.paths.binPrevious;
	if (!existsSync(previous)) return;
	try {
		await rm(previous, { recursive: true, force: true });
		return;
	} catch {}
	const trash = path.join(ctx.paths.bin, `.trash-${uniqueSuffix()}`);
	try {
		await io.rename(previous, trash);
		return;
	} catch {}
	await mkdir(trash, { recursive: true });
	for (const entry of await readdir(previous)) await io.rename(path.join(previous, entry), path.join(trash, entry));
	await rm(previous, { recursive: true, force: true });
}

/**
 * Installs a staging dir from {@link stageBinaries} as a transaction:
 * 1. discards the old `bin/previous/`;
 * 2. moves each current binary into a new `bin/previous/`;
 * 3. moves each staged binary into `bin/` (any failure in 2–3 moves everything back and rethrows);
 * 4. runs `bin/bgb --version`; a mismatch moves the new binaries to `bin/.trash-*`, restores
 *    `previous/` and throws.
 * The staging dir is consumed unless rolling back itself fails (then it keeps what could not move back).
 * Runs under the `binaries` lock (`withBinariesLock`): a concurrent transaction, which would discard the
 * `previous/` this one is about to create, gets `BgbError("conflict")` instead.
 */
export async function commitBinaries(ctx: CoreContext, stagedDir: string, io: BinariesIo = systemBinariesIo): Promise<void> {
	await withBinariesLock(ctx.paths, async () => {
		const { bin, binPrevious } = ctx.paths;
		const names = binaryNames(ctx);
		const expected = (await readFile(path.join(stagedDir, STAGED_VERSION_FILE), "utf8")).trim();
		await discardPrevious(ctx, io);
		await mkdir(binPrevious, { recursive: true });
		try {
			await moveTransaction(io, async (move) => {
				for (const name of names) {
					if (existsSync(path.join(bin, name))) await move(path.join(bin, name), path.join(binPrevious, name));
				}
				for (const name of names) await move(path.join(stagedDir, name), path.join(bin, name));
			});
		} catch (error) {
			if (!(error instanceof RollbackFailedError)) await rm(stagedDir, { recursive: true, force: true });
			throw error;
		}
		await rm(stagedDir, { recursive: true, force: true });

		const installed = await readVersion(io, path.join(bin, names[0])).catch((error: unknown) => `error: ${errorMessage(error)}`);
		if (installed !== expected) {
			await replaceInstalled(ctx, binPrevious, io);
			await rm(binPrevious, { recursive: true, force: true });
			throw new Error(`the installed bgb reports "${installed}", expected ${expected}; restored the previous binaries`);
		}
		// A first install replaced nothing; an empty `previous/` would only confuse `restorePrevious`.
		if ((await readdir(binPrevious)).length === 0) await rm(binPrevious, { recursive: true, force: true });
	});
}

/**
 * Moves the installed binaries into a new `bin/.trash-*`, then moves the binaries found in `fromDir`
 * (if any) into `bin/`, as one {@link moveTransaction}; finally deletes the trash where possible.
 */
async function replaceInstalled(ctx: CoreContext, fromDir: string | null, io: BinariesIo): Promise<void> {
	const { bin } = ctx.paths;
	const names = binaryNames(ctx);
	const trash = path.join(bin, `.trash-${uniqueSuffix()}`);
	await mkdir(trash, { recursive: true });
	await moveTransaction(io, async (move) => {
		for (const name of names) {
			if (existsSync(path.join(bin, name))) await move(path.join(bin, name), path.join(trash, name));
		}
		if (fromDir === null) return;
		for (const name of names) {
			if (existsSync(path.join(fromDir, name))) await move(path.join(fromDir, name), path.join(bin, name));
		}
	});
	// Windows can't delete a running exe; the agent deletes leftover `bin/.trash-*` at start.
	await rm(trash, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Moves the binaries in `bin/previous/` back into `bin/`, discarding the current ones (the update
 * watchdog's rollback and setup's undo). Throws when `previous/` holds no CLI binary. Runs under the
 * `binaries` lock, like {@link commitBinaries}.
 */
export async function restorePrevious(ctx: CoreContext, io: BinariesIo = systemBinariesIo): Promise<void> {
	await withBinariesLock(ctx.paths, async () => {
		const [main] = binaryNames(ctx);
		if (!existsSync(path.join(ctx.paths.binPrevious, main))) {
			throw new Error(`no previous Better Grok Bot binaries in ${ctx.paths.binPrevious}`);
		}
		await replaceInstalled(ctx, ctx.paths.binPrevious, io);
		await rm(ctx.paths.binPrevious, { recursive: true, force: true }).catch(() => undefined);
	});
}

/** Removes the installed binaries (setup's undo of a first install, which left no `previous/`), under the `binaries` lock. */
export async function removeBinaries(ctx: CoreContext, io: BinariesIo = systemBinariesIo): Promise<void> {
	await withBinariesLock(ctx.paths, () => replaceInstalled(ctx, null, io));
}

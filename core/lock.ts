import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { type FileHandle, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { BgbError } from "./errors.ts";
import type { DataPaths } from "./paths.ts";
import { asProcessIdentity, identityAlive, selfIdentity } from "./proc.ts";

export type LockName = "binaries" | "build" | "config" | "state";

/** {@link withLock} gave up waiting for a live holder. */
export class LockTimeoutError extends Error {
	constructor(
		readonly lock: LockName,
		holderPid: number | "unknown",
	) {
		super(`timed out waiting for the ${lock} lock (held by pid ${holderPid})`);
		this.name = "LockTimeoutError";
	}
}

/** A record file that never became valid JSON is abandoned after this long (a writer died mid-create). */
const UNPARSABLE_GRACE_MS = 5_000;
const POLL_MAX_MS = 100;
/** Reclaim mutexes are held for a few file operations; a holder alive this long is waited out, then reported. */
const RECLAIM_WAIT_MS = 10_000;

interface RecordSnapshot {
	text: string;
	ino: number;
	mtimeMs: number;
}

/** The record's text and the inode/mtime it was read from (one handle, so they belong together); `undefined` when absent. */
async function snapshot(file: string): Promise<RecordSnapshot | undefined> {
	let handle: FileHandle;
	try {
		handle = await open(file, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const info = await handle.stat();
		return { text: await handle.readFile("utf8"), ino: info.ino, mtimeMs: info.mtimeMs };
	} finally {
		await handle.close();
	}
}

/** Deletes `file` by moving it aside first, so its name is free at once (Windows keeps a deleted, still-open name busy). */
async function removeNow(file: string): Promise<void> {
	const aside = `${file}.gone-${randomBytes(6).toString("hex")}`;
	try {
		await rename(file, aside);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	await rm(aside, { force: true });
}

/**
 * Runs `fn` while holding `<file>.reclaim`, the mutex every deletion of `file` happens under: a stale
 * record's reclamation and its owner's release. A record is only ever created while its name is free
 * (`wx`), so under this mutex `file` changes only by the holder's own hand; a check made under it still
 * holds when the holder acts. The mutex is itself a record file, so a reclaimer that died holding it is
 * reclaimed the same way, under `<file>.reclaim.reclaim`.
 */
async function withReclaimMutex<T>(file: string, fn: () => Promise<T>): Promise<T> {
	const mutex = `${file}.reclaim`;
	const text = JSON.stringify({ ...(await selfIdentity()), at: new Date().toISOString(), nonce: randomBytes(6).toString("hex") });
	const deadline = Date.now() + RECLAIM_WAIT_MS;
	let delay = 2;
	for (;;) {
		const result = await claimRecordFile(mutex, text);
		if (result.claimed) break;
		if (Date.now() >= deadline) {
			const pid = typeof result.holder?.pid === "number" ? result.holder.pid : "unknown";
			throw new Error(`timed out waiting for ${mutex} (held by pid ${pid})`);
		}
		await Bun.sleep(delay);
		delay = Math.min(delay * 2, POLL_MAX_MS);
	}
	try {
		return await fn();
	} finally {
		await removeNow(mutex);
	}
}

/** Deletes this process's own record `file` while it still holds `text` (a holder's release). */
export async function releaseRecordFile(file: string, text: string): Promise<void> {
	await withReclaimMutex(file, async () => {
		if ((await snapshot(file))?.text === text) await removeNow(file);
	});
}

export type ClaimResult = { claimed: true } | { claimed: false; holder: Record<string, unknown> | undefined };

/** Test seam for {@link claimRecordFile}. */
export interface ClaimHooks {
	/** Runs after a record was judged stale, before it is reclaimed. */
	judgedStale?(): Promise<void>;
}

/**
 * Creates `file` exclusively with `text`. A record whose process is gone (or a fresh pid with another
 * start time), or an unparsable record older than 5 s, is stale and is replaced. Otherwise returns the
 * live holder's parsed record (`undefined` while it is still being written).
 *
 * Reclamation happens under {@link withReclaimMutex} and deletes the record only if it is still the
 * very file judged stale (same text, inode and mtime). Two processes that judged the same record stale
 * therefore never move or delete the fresh record the first of them created.
 */
export async function claimRecordFile(file: string, text: string, hooks: ClaimHooks = {}): Promise<ClaimResult> {
	for (;;) {
		try {
			await writeFile(file, text, { flag: "wx" });
			return { claimed: true };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const seen = await snapshot(file);
		if (seen === undefined) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(seen.text);
		} catch {
			parsed = undefined;
		}
		const identity = asProcessIdentity(parsed);
		if (identity) {
			if (await identityAlive(identity)) return { claimed: false, holder: parsed as Record<string, unknown> };
		} else if (Date.now() - seen.mtimeMs <= UNPARSABLE_GRACE_MS) {
			return { claimed: false, holder: undefined };
		}
		await hooks.judgedStale?.();
		await withReclaimMutex(file, async () => {
			const current = await snapshot(file);
			if (current?.text === seen.text && current.ino === seen.ino && current.mtimeMs === seen.mtimeMs) await removeNow(file);
		});
	}
}

/**
 * Runs `fn` while holding `DATA/locks/<name>.lock` across processes. Not re-entrant. Acquire order is
 * binaries → build → config → state; never take one while holding a later one. Throws
 * {@link LockTimeoutError} when a live holder keeps it past `timeoutMs`.
 */
export async function withLock<T>(
	paths: DataPaths,
	name: LockName,
	fn: () => T | Promise<T>,
	timeoutMs: number = name === "build" ? 120_000 : 10_000,
): Promise<T> {
	const file = path.join(paths.locks, `${name}.lock`);
	const text = JSON.stringify({ ...(await selfIdentity()), at: new Date().toISOString() });
	await mkdir(paths.locks, { recursive: true });
	const deadline = Date.now() + timeoutMs;
	let delay = 5;
	for (;;) {
		const result = await claimRecordFile(file, text);
		if (result.claimed) break;
		if (Date.now() >= deadline) {
			throw new LockTimeoutError(name, typeof result.holder?.pid === "number" ? result.holder.pid : "unknown");
		}
		await Bun.sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
		delay = Math.min(delay * 2, POLL_MAX_MS);
	}
	try {
		return await fn();
	} finally {
		await releaseRecordFile(file, text);
	}
}

/** `DATA` roots whose binaries lock the current async call chain holds. */
const binariesHolder = new AsyncLocalStorage<string>();

/**
 * Runs `fn` while holding the `binaries` lock: the one transaction over `DATA/bin` (install, update,
 * rollback) at a time, across processes and within one. Re-entrant within `fn`'s own async call chain,
 * so a transaction can call `commitBinaries`/`restorePrevious`, which take it themselves. Anyone else
 * holding it for longer than `waitMs` → `BgbError("conflict")`.
 */
export async function withBinariesLock<T>(paths: DataPaths, fn: () => Promise<T>, waitMs = 2_000): Promise<T> {
	if (binariesHolder.getStore() === paths.root) return fn();
	try {
		return await withLock(paths, "binaries", () => binariesHolder.run(paths.root, fn), waitMs);
	} catch (error) {
		if (error instanceof LockTimeoutError && error.lock === "binaries") {
			throw new BgbError("conflict", "another Better Grok Bot install or update is in progress");
		}
		throw error;
	}
}

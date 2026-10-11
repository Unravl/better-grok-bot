import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { DataPaths } from "./paths.ts";
import { asProcessIdentity, identityAlive, selfIdentity } from "./proc.ts";

export type LockName = "build" | "config" | "state";

/** A record file that never became valid JSON is abandoned after this long (a writer died mid-create). */
const UNPARSABLE_GRACE_MS = 5_000;
const POLL_MAX_MS = 100;

/**
 * Deletes `file` only while it still holds `expected`. The file is first moved aside, so a concurrent
 * claimer's fresh record that replaced it in between is put back instead of deleted.
 */
export async function removeRecordFileIfUnchanged(file: string, expected: string): Promise<void> {
	const aside = `${file}.gone-${randomBytes(6).toString("hex")}`;
	try {
		await rename(file, aside);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	try {
		const moved = await readFile(aside, "utf8");
		if (moved !== expected) await link(aside, file).catch(() => undefined);
	} finally {
		await rm(aside, { force: true });
	}
}

export type ClaimResult = { claimed: true } | { claimed: false; holder: Record<string, unknown> | undefined };

/**
 * Creates `file` exclusively with `text`. A record whose process is gone (or a fresh pid with another
 * start time), or an unparsable record older than 5 s, is stale and is replaced. Otherwise returns the
 * live holder's parsed record (`undefined` while it is still being written).
 */
export async function claimRecordFile(file: string, text: string): Promise<ClaimResult> {
	for (;;) {
		try {
			await writeFile(file, text, { flag: "wx" });
			return { claimed: true };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let existing: string;
		try {
			existing = await readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(existing);
		} catch {
			parsed = undefined;
		}
		const identity = asProcessIdentity(parsed);
		if (identity) {
			if (await identityAlive(identity)) return { claimed: false, holder: parsed as Record<string, unknown> };
		} else {
			const info = await stat(file).catch(() => undefined);
			if (!info) continue;
			if (Date.now() - info.mtimeMs <= UNPARSABLE_GRACE_MS) return { claimed: false, holder: undefined };
		}
		await removeRecordFileIfUnchanged(file, existing);
	}
}

/**
 * Runs `fn` while holding `DATA/locks/<name>.lock` across processes. Not re-entrant. Acquire order is
 * build → config → state; never take `build` while holding `config` or `state`.
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
			const pid = typeof result.holder?.pid === "number" ? result.holder.pid : "unknown";
			throw new Error(`timed out waiting for the ${name} lock (held by pid ${pid})`);
		}
		await Bun.sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
		delay = Math.min(delay * 2, POLL_MAX_MS);
	}
	try {
		return await fn();
	} finally {
		await removeRecordFileIfUnchanged(file, text);
	}
}

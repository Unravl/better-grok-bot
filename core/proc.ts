import { readFile } from "node:fs/promises";
import { FFIType, type Library, dlopen, ptr } from "bun:ffi";

/**
 * A process, distinguishable from a later process that reuses its pid. Both fields come from the OS
 * source {@link processStartTime} reads, so the same process always yields identical values and
 * {@link identityAlive} compares them exactly.
 */
export interface ProcessIdentity {
	pid: number;
	/**
	 * Identifies the OS boot (macOS `kern.boottime`, Linux `boot_id`). `null` on Windows, where the start
	 * time is an absolute 100 ns creation timestamp that a process after a reboot cannot repeat.
	 */
	bootId: string | null;
	/**
	 * Process start time in epoch ms, at the OS's precision: Linux clock ticks since boot (10 ms), macOS
	 * `ps -o lstart` (1 s; pids are handed out sequentially up to 99,999 before wrapping, so a reused pid
	 * never starts in the same second), Windows `GetProcessTimes` creation time (truncated to 1 ms).
	 */
	startTime: number;
}

/** True while a process with this pid exists (including one we may not signal). */
export function isAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function run(argv: string[]): Promise<string | null> {
	try {
		const proc = Bun.spawn(argv, {
			stdin: "ignore",
			stdout: "pipe",
			env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
			stderr: "ignore",
		});
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return code === 0 ? out.trim() : null;
	} catch {
		return null;
	}
}

async function linuxBootTimeSec(): Promise<number | null> {
	const stat = await readFile("/proc/stat", "utf8").catch(() => null);
	const match = stat?.match(/^btime (\d+)$/m);
	return match?.[1] ? Number(match[1]) : null;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** 100 ns intervals from 1601-01-01 (FILETIME epoch) to 1970-01-01. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;

const KERNEL32_SYMBOLS = {
	OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
	GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
	CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
} as const;

let kernel32: Library<typeof KERNEL32_SYMBOLS> | undefined;

/** Windows: the creation time `GetProcessTimes` reports, without spawning PowerShell. */
function win32StartTime(pid: number): number | null {
	kernel32 ??= dlopen("kernel32.dll", KERNEL32_SYMBOLS);
	const { OpenProcess, GetProcessTimes, CloseHandle } = kernel32.symbols;
	const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
	if (handle === null) return null;
	try {
		// creation, exit, kernel, user: four FILETIMEs (little-endian 64-bit counts of 100 ns).
		const times = new BigUint64Array(4);
		if (!GetProcessTimes(handle, ptr(times, 0), ptr(times, 8), ptr(times, 16), ptr(times, 24))) return null;
		const creation = times[0] ?? 0n;
		return creation > FILETIME_UNIX_EPOCH ? Number((creation - FILETIME_UNIX_EPOCH) / 10_000n) : null;
	} finally {
		CloseHandle(handle);
	}
}

/** Start time of `pid` in epoch ms (precision per {@link ProcessIdentity.startTime}), or `null` if the process is gone or unreadable. */
export async function processStartTime(pid: number): Promise<number | null> {
	if (!isAlive(pid)) return null;
	switch (process.platform) {
		case "darwin": {
			// `ps` runs with TZ=UTC0 and LC_ALL=C: "Sun Oct 11 11:02:27 2026".
			const out = await run(["ps", "-o", "lstart=", "-p", String(pid)]);
			const match = out?.match(/^\w{3}\s+(\w{3})\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d{4})$/);
			if (!match) return null;
			const [, mon = "", day, h, m, s, year] = match;
			const month = "JanFebMarAprMayJunJulAugSepOctNovDec".indexOf(mon) / 3;
			return Number.isInteger(month) && month >= 0
				? Date.UTC(Number(year), month, Number(day), Number(h), Number(m), Number(s))
				: null;
		}
		case "linux": {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
			if (!stat) return null;
			// Field 22 (starttime, clock ticks since boot); fields after the last ")" start at field 3.
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			const ticks = Number(fields[19]);
			const btime = await linuxBootTimeSec();
			if (!Number.isFinite(ticks) || btime === null) return null;
			return Math.round((btime + ticks / 100) * 1000);
		}
		case "win32":
			try {
				return win32StartTime(pid);
			} catch {
				return null;
			}
		default:
			return null;
	}
}

let bootIdPromise: Promise<string | null> | undefined;

/** Identifies the current OS boot (memoized); `null` on Windows (see {@link ProcessIdentity.bootId}). */
export function bootId(): Promise<string | null> {
	bootIdPromise ??= (async () => {
		switch (process.platform) {
			case "darwin": {
				const out = await run(["sysctl", "-n", "kern.boottime"]);
				return out?.match(/sec = (\d+)/)?.[1] ?? null;
			}
			case "linux": {
				const id = await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => null);
				return id?.trim() || null;
			}
			default:
				return null;
		}
	})();
	return bootIdPromise;
}

let selfPromise: Promise<ProcessIdentity> | undefined;

/**
 * This process's identity (memoized), read from the same source as {@link processStartTime} so other
 * processes verify it exactly. Throws when the start time is unreadable: an unverifiable record would
 * never count as alive, so writing one would let anyone take this process's lock.
 */
export function selfIdentity(): Promise<ProcessIdentity> {
	selfPromise ??= (async () => {
		const pid = process.pid;
		const startTime = await processStartTime(pid);
		if (startTime === null) {
			selfPromise = undefined; // a later call retries
			throw new Error(`cannot read the start time of this process (pid ${pid})`);
		}
		return { pid, bootId: await bootId(), startTime };
	})();
	return selfPromise;
}

/**
 * True only while the exact process described by `id` still runs: same boot and the same start time,
 * compared exactly. A process whose start time can't be read (gone, or not ours to inspect) never
 * counts as alive, so a reused pid is never mistaken for the recorded process and never signaled.
 */
export async function identityAlive(id: ProcessIdentity): Promise<boolean> {
	if (!isAlive(id.pid)) return false;
	if (id.bootId !== (await bootId())) return false;
	return (await processStartTime(id.pid)) === id.startTime;
}

/**
 * Parses an unknown value into a {@link ProcessIdentity}, or `undefined` when malformed. A record
 * without a start time is unverifiable and therefore malformed.
 */
export function asProcessIdentity(value: unknown): ProcessIdentity | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { pid, bootId: boot, startTime } = value as Record<string, unknown>;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (boot !== null && typeof boot !== "string") return undefined;
	if (typeof startTime !== "number" || !Number.isFinite(startTime)) return undefined;
	return { pid, bootId: boot, startTime };
}

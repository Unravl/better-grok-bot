import { readFile } from "node:fs/promises";
import { runPowerShell } from "./powershell.ts";

/** A process, distinguishable from a later process that reuses its pid. */
export interface ProcessIdentity {
	pid: number;
	/** Identifies the OS boot; `null` where unavailable (Windows). */
	bootId: string | null;
	/** Process start time in epoch ms; `null` when it could not be read. */
	startTime: number | null;
}

/** Start times read by different means (ps second precision, /proc ticks, PowerShell) agree within this. */
const START_TIME_TOLERANCE_MS = 2_000;

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

/** Start time of `pid` in epoch ms, or `null` if the process is gone or unreadable. */
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
		case "win32": {
			const out = await runPowerShell(
				`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){[DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds()}`,
			).catch(() => null);
			const ms = out ? Number(out) : Number.NaN;
			return Number.isFinite(ms) ? ms : null;
		}
		default:
			return null;
	}
}

let bootIdPromise: Promise<string | null> | undefined;

/** Identifies the current OS boot (memoized). */
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

/** This process's identity (memoized). */
export function selfIdentity(): Promise<ProcessIdentity> {
	selfPromise ??= (async () => {
		const pid = process.pid;
		// Windows: avoid a PowerShell round trip per process; Bun's time origin is the process start.
		const startTime =
			process.platform === "win32" ? Math.round(performance.timeOrigin) : await processStartTime(pid);
		return { pid, bootId: await bootId(), startTime };
	})();
	return selfPromise;
}

/** True while the exact process described by `id` still runs (not a later process reusing its pid). */
export async function identityAlive(id: ProcessIdentity): Promise<boolean> {
	if (!isAlive(id.pid)) return false;
	const currentBoot = await bootId();
	if (id.bootId !== null && currentBoot !== null && id.bootId !== currentBoot) return false;
	if (id.startTime === null) return true;
	const start = await processStartTime(id.pid);
	if (start === null) return isAlive(id.pid);
	return Math.abs(start - id.startTime) <= START_TIME_TOLERANCE_MS;
}

/** Parses an unknown value into a {@link ProcessIdentity}, or `undefined` when malformed. */
export function asProcessIdentity(value: unknown): ProcessIdentity | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { pid, bootId: boot, startTime } = value as Record<string, unknown>;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (boot !== null && typeof boot !== "string") return undefined;
	if (startTime !== null && typeof startTime !== "number") return undefined;
	return { pid, bootId: boot, startTime };
}

import { FFIType, type Pointer, dlopen, read } from "bun:ffi";
import { open } from "node:fs/promises";

const POLL_MAX_MS = 10;

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EINTR = 4;

const GENERIC_READ_WRITE = 0xc000_0000;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE_VALUE = -1n;
const ERROR_SHARING_VIOLATION = 32;
const ERROR_LOCK_VIOLATION = 33;

/** `"busy"` while another holder has the lock; `{ code }` for any other failure. */
type TryResult<T> = T | "busy" | { code: number };

interface Posix {
	tryLock(fd: number): TryResult<"ok">;
	unlock(fd: number): void;
}

interface Win32 {
	/** Opens `path` with no sharing; busy while another handle has it open. */
	openExclusive(path: string): TryResult<bigint>;
	close(handle: bigint): void;
}

let posix: Posix | undefined;
let win32: Win32 | undefined;

const flockSymbol = { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
const errnoSymbol = { args: [], returns: FFIType.ptr } as const;

interface Libc {
	flock(fd: number, operation: number): number;
	errno(): number;
}

/** `flock` and the calling thread's errno from the C library `name`. */
function openLibc(name: string): Libc {
	const readErrno = (location: Pointer | bigint | null) => (typeof location === "number" ? read.i32(location, 0) : 0);
	if (process.platform === "darwin") {
		const { symbols } = dlopen(name, { flock: flockSymbol, __error: errnoSymbol });
		return { flock: symbols.flock, errno: () => readErrno(symbols.__error()) };
	}
	const { symbols } = dlopen(name, { flock: flockSymbol, __errno_location: errnoSymbol });
	return { flock: symbols.flock, errno: () => readErrno(symbols.__errno_location()) };
}

function loadPosix(): Posix {
	if (posix) return posix;
	let libc: Libc | undefined;
	const candidates = process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	const failures: string[] = [];
	for (const candidate of candidates) {
		try {
			libc = openLibc(candidate);
			break;
		} catch (error) {
			failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!libc) throw new Error(`cannot load the C library (${failures.join("; ")})`);
	const { flock, errno } = libc;
	// EWOULDBLOCK: 35 on darwin, 11 (EAGAIN) on linux.
	const wouldBlock = process.platform === "darwin" ? 35 : 11;
	posix = {
		tryLock(fd) {
			if (flock(fd, LOCK_EX | LOCK_NB) === 0) return "ok";
			const code = errno();
			// 0: errno was not observable; treat it as contention and let the deadline bound it.
			return code === wouldBlock || code === EINTR || code === 0 ? "busy" : { code };
		},
		unlock(fd) {
			flock(fd, LOCK_UN);
		},
	};
	return posix;
}

function loadWin32(): Win32 {
	if (win32) return win32;
	const { symbols } = dlopen("kernel32.dll", {
		CreateFileW: {
			args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
			returns: FFIType.i64,
		},
		CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	});
	win32 = {
		openExclusive(path) {
			const wide = Buffer.from(`${path}\0`, "utf16le");
			const handle = symbols.CreateFileW(wide, GENERIC_READ_WRITE, 0, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null);
			if (handle !== INVALID_HANDLE_VALUE) return handle;
			const code = symbols.GetLastError();
			// 0: the error code was not observable; treat it as contention and let the deadline bound it.
			return code === ERROR_SHARING_VIOLATION || code === ERROR_LOCK_VIOLATION || code === 0 ? "busy" : { code };
		},
		close(handle) {
			symbols.CloseHandle(handle);
		},
	};
	return win32;
}

/** Calls `attempt` until it stops reporting busy, backing off a few ms; throws on failure or after `deadline`. */
async function poll<T>(file: string, deadline: number, attempt: () => TryResult<T>): Promise<T> {
	let delay = 1;
	for (;;) {
		const result = attempt();
		if (result !== "busy") {
			if (typeof result === "object" && result !== null && "code" in result) {
				throw new Error(`cannot lock ${file} (OS error ${result.code})`);
			}
			return result;
		}
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
		await Bun.sleep(delay);
		delay = Math.min(delay * 2, POLL_MAX_MS);
	}
}

/**
 * Runs `fn` while holding an exclusive OS lock on `file` (created empty if missing, never deleted):
 * `flock` on POSIX, an unshared handle on Windows. The kernel drops it when the holder's process dies,
 * and two handles in one process exclude each other too. Polls without blocking the JS thread; throws
 * after `timeoutMs`. Hold it only for short critical sections.
 */
export async function withOsLock<T>(file: string, fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	if (process.platform === "win32") {
		const { openExclusive, close } = loadWin32();
		const handle = await poll(file, deadline, () => openExclusive(file));
		try {
			return await fn();
		} finally {
			close(handle);
		}
	}
	const { tryLock, unlock } = loadPosix();
	const handle = await open(file, "a", 0o600);
	try {
		await poll(file, deadline, () => tryLock(handle.fd));
		try {
			return await fn();
		} finally {
			// Explicit unlock: a child process that inherited the descriptor must not keep the lock.
			unlock(handle.fd);
		}
	} finally {
		await handle.close();
	}
}

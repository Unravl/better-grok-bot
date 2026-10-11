import { type HelperKeysAccess, type KeysState, type Platform, type ServiceStateInfo, WATCHABLE_CODES } from "../../sdk/index.ts";
import { BgbError } from "../errors.ts";

export const KEYS_WATCH_ERROR = "only modifier, function, lock and media keys can be watched in the background";

/** Validates `keys.watch` params: an array of `WATCHABLE_CODES` strings (duplicates removed). */
export function parseWatchCodes(codes: unknown): string[] {
	if (!Array.isArray(codes) || !codes.every((code) => typeof code === "string")) {
		throw new BgbError("bad-request", "codes must be an array of strings");
	}
	const invalid = codes.filter((code) => !WATCHABLE_CODES.has(code));
	if (invalid.length > 0) throw new BgbError("bad-request", `${KEYS_WATCH_ERROR} (got ${invalid.join(", ")})`);
	return [...new Set(codes)];
}

/**
 * Per-connection background key watches and the down state of watched codes. Pure bookkeeping:
 * the caller sends the helper `watch` frames and the renderer events this class computes.
 */
export class KeyWatches {
	private readonly byConnection = new Map<number, ReadonlySet<string>>();
	private readonly down = new Set<string>();

	/** Replaces one connection's watched set; true when the union changed. */
	set(connectionId: number, codes: Iterable<string>): boolean {
		const before = this.union().join("\n");
		const next = new Set(codes);
		if (next.size === 0) this.byConnection.delete(connectionId);
		else this.byConnection.set(connectionId, next);
		return this.settle(before);
	}

	/** Forgets a closed connection; true when the union changed. */
	drop(connectionId: number): boolean {
		const before = this.union().join("\n");
		this.byConnection.delete(connectionId);
		return this.settle(before);
	}

	/** Sorted union of every connection's codes. */
	union(): string[] {
		const all = new Set<string>();
		for (const codes of this.byConnection.values()) for (const code of codes) all.add(code);
		return [...all].sort();
	}

	watchers(code: string): number[] {
		return [...this.byConnection].filter(([, codes]) => codes.has(code)).map(([id]) => id);
	}

	/** Applies a helper `key` frame; returns the connections to notify, or `[]` when nothing changed. */
	key(code: string, down: boolean): number[] {
		const watchers = this.watchers(code);
		if (watchers.length === 0 || this.down.has(code) === down) return [];
		if (down) this.down.add(code);
		else this.down.delete(code);
		return watchers;
	}

	/** Marks every down code up (helper gone) and returns the `down:false` events owed to watchers. */
	releaseAll(): { code: string; connections: number[] }[] {
		const released = [...this.down].sort().map((code) => ({ code, connections: this.watchers(code) }));
		this.down.clear();
		return released;
	}

	/** Codes no longer watched by anyone are forgotten without events. */
	private settle(before: string): boolean {
		const union = this.union();
		for (const code of this.down) if (!union.includes(code)) this.down.delete(code);
		return union.join("\n") !== before;
	}
}

export interface KeysStateInput {
	platform: Platform;
	/** Set when background keys can never work here (Wayland, no helper published for this OS/arch). */
	unsupportedReason: string | null;
	/** macOS: the helper app and its LaunchAgent are being installed. */
	installing: boolean;
	/** macOS: the helper LaunchAgent exists. Windows/Linux: unused (the helper runs on demand). */
	installed: boolean;
	installError: string | null;
	/** The connected helper's access, or `null` while none has said hello. */
	access: HelperKeysAccess | null;
	/** macOS: a helper was connected and its socket closed. */
	helperLost: boolean;
	/** Windows/Linux: a helper child is being downloaded/started, or a restart is scheduled. */
	starting: boolean;
	failures: number;
	maxFailures: number;
	lastFailure: string | null;
}

function fromAccess(access: HelperKeysAccess): ServiceStateInfo<KeysState> {
	switch (access) {
		case "granted":
			return { state: "ready" };
		case "denied":
			return {
				state: "needs-permission",
				detail: "Allow Better Grok Bot Helper in System Settings → Privacy & Security → Input Monitoring",
			};
		case "unsupported":
			return { state: "unsupported", detail: "the helper cannot watch keys in this session" };
	}
}

/** The `keys.state` the agent reports (state machine of Step 4.6). */
export function computeKeysState(input: KeysStateInput): ServiceStateInfo<KeysState> {
	if (input.unsupportedReason !== null) return { state: "unsupported", detail: input.unsupportedReason };
	if (input.platform === "darwin") {
		if (input.installing) return { state: "installing" };
		if (!input.installed) {
			return input.installError === null
				? { state: "needs-install" }
				: { state: "needs-install", detail: `install failed: ${input.installError}` };
		}
		if (input.access !== null) return fromAccess(input.access);
		if (input.helperLost) return { state: "error", detail: "helper disconnected" };
		return { state: "starting" };
	}
	if (input.failures >= input.maxFailures) {
		return { state: "error", detail: input.lastFailure ?? "the helper failed to start" };
	}
	if (input.access !== null) return fromAccess(input.access);
	return input.starting ? { state: "starting" } : { state: "ready" };
}

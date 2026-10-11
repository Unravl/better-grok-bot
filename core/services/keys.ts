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

	/**
	 * Replaces one connection's watched set. `unionChanged`: the helper needs a new `watch` frame;
	 * `held`: codes this connection just started watching that are down now (owed it a `down:true`).
	 */
	set(connectionId: number, codes: Iterable<string>): { unionChanged: boolean; held: string[] } {
		const before = this.union().join("\n");
		const previous = this.byConnection.get(connectionId);
		const next = new Set(codes);
		if (next.size === 0) this.byConnection.delete(connectionId);
		else this.byConnection.set(connectionId, next);
		const held = [...next].filter((code) => this.down.has(code) && !previous?.has(code)).sort();
		return { unionChanged: this.settle(before), held };
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
	/** macOS: why the last install failed; shown over the installed files while no helper is connected. */
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

/**
 * The state for a connected helper's key access. "denied" means missing Input Monitoring on macOS;
 * on Windows/Linux the helper could not install its keyboard hook (it keeps retrying and sends
 * "granted" once it succeeds).
 */
function fromAccess(platform: Platform, access: HelperKeysAccess): ServiceStateInfo<KeysState> {
	switch (access) {
		case "granted":
			return { state: "ready" };
		case "denied":
			return platform === "darwin"
				? {
						state: "needs-permission",
						detail: "Allow Better Grok Bot Helper in System Settings → Privacy & Security → Input Monitoring",
					}
				: { state: "error", detail: "the helper could not install its keyboard hook" };
		case "unsupported":
			return { state: "unsupported", detail: "the helper cannot watch keys in this session" };
	}
}

/** The `keys.state` the agent reports (state machine of Step 4.6). */
export function computeKeysState(input: KeysStateInput): ServiceStateInfo<KeysState> {
	if (input.unsupportedReason !== null) return { state: "unsupported", detail: input.unsupportedReason };
	if (input.platform === "darwin") {
		if (input.installing) return { state: "installing" };
		if (input.access !== null) return fromAccess(input.platform, input.access);
		if (input.installError !== null) return { state: "needs-install", detail: `install failed: ${input.installError}` };
		if (!input.installed) return { state: "needs-install" };
		if (input.helperLost) return { state: "error", detail: "helper disconnected" };
		return { state: "starting" };
	}
	if (input.failures >= input.maxFailures) {
		return { state: "error", detail: input.lastFailure ?? "the helper failed to start" };
	}
	if (input.access !== null) return fromAccess(input.platform, input.access);
	return input.starting ? { state: "starting" } : { state: "ready" };
}

import type { KeysState, MediaState, ServiceStateInfo } from "../sdk/index.ts";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import { withLock } from "./lock.ts";
import type { DataPaths } from "./paths.ts";
import type { HookRecord } from "./platform/types.ts";

/** `DATA/state.json`, shared by the CLI and the agent. */
export interface State {
	lastBuild: { key: string; appVersion: string; builtAt: string } | null;
	asarFingerprint: { path: string; size: number; mtimeMs: number; sha256: string } | null;
	update: {
		checkedAt: string | null;
		latest: string | null;
		pending: { version: string; previous: string; at: string } | null;
		error: string | null;
	};
	/** appVersion → plugin ids already reported as failing for it. */
	notified: Record<string, string[]>;
	migratedGrokMods: boolean;
	hook: HookRecord | null;
	/** Live only while `readLiveAgent` finds an agent. */
	renderers: { buildKey: string; connectedAt: string }[];
	/** Live only while `readLiveAgent` finds an agent. */
	services: { keys: ServiceStateInfo<KeysState>; media: ServiceStateInfo<MediaState> } | null;
}

export function defaultState(): State {
	return {
		lastBuild: null,
		asarFingerprint: null,
		update: { checkedAt: null, latest: null, pending: null, error: null },
		notified: {},
		migratedGrokMods: false,
		hook: null,
		renderers: [],
		services: null,
	};
}

/** Merges a parsed `state.json` over the defaults, so missing keys (older files) read as defaults. */
function withDefaults(value: unknown, file: string): State {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${file}: expected a JSON object`);
	}
	const defaults = defaultState();
	const raw = value as Partial<State>;
	const update = typeof raw.update === "object" && raw.update !== null ? raw.update : {};
	return { ...defaults, ...raw, update: { ...defaults.update, ...update } };
}

/** Reads `state.json`; defaults when missing. */
export async function readState(paths: DataPaths): Promise<State> {
	const value = await readJsonFile(paths.state);
	return value === undefined ? defaultState() : withDefaults(value, paths.state);
}

/**
 * Under the state lock: reads a fresh copy, lets `fn` edit it in place or return a replacement, and
 * atomically replaces the file.
 */
export async function mutateState(
	paths: DataPaths,
	fn: (state: State) => State | undefined | void | Promise<State | undefined | void>,
): Promise<State> {
	return withLock(paths, "state", async () => {
		const draft = await readState(paths);
		const next = (await fn(draft)) ?? draft;
		await writeJsonAtomic(paths.state, next);
		return next;
	});
}

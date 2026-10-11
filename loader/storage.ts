import { STORAGE_PREFIX, type PluginLogger, type PluginStorage } from "../sdk/index.ts";
import { describeError } from "./logger.ts";

interface CacheEntry {
	/** False when the key is absent or holds malformed JSON: `get` returns its fallback. */
	present: boolean;
	value: unknown;
}

/** `localStorage`, or `undefined` where merely touching it throws (sandboxed or opaque origins). */
export function getLocalStorage(): Storage | undefined {
	try {
		return globalThis.localStorage ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * JSON storage under `localStorage["bgb:<pluginId>:<key>"]`. Parsed values are cached per key,
 * so `get` returns the same reference until that key changes, which keeps object values safe as
 * `useSyncExternalStore` snapshots.
 */
export function createStorage(pluginId: string, log: PluginLogger): PluginStorage {
	const prefix = `${STORAGE_PREFIX}${pluginId}:`;
	const cache = new Map<string, CacheEntry>();
	const listeners = new Map<string, Set<() => void>>();
	let readFailureLogged = false;

	const notify = (key: string): void => {
		const keyListeners = listeners.get(key);
		if (keyListeners === undefined) return;
		for (const listener of [...keyListeners]) {
			try {
				listener();
			} catch (error) {
				log.error(`storage listener for "${key}" threw:`, error);
			}
		}
	};

	if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
		window.addEventListener("storage", (event: StorageEvent) => {
			if (event.storageArea !== null && event.storageArea !== getLocalStorage()) return;
			if (event.key === null) {
				// Another window called `localStorage.clear()`.
				cache.clear();
				for (const key of [...listeners.keys()]) notify(key);
				return;
			}
			if (!event.key.startsWith(prefix)) return;
			const key = event.key.slice(prefix.length);
			cache.delete(key);
			notify(key);
		});
	}

	return Object.freeze({
		get<T>(key: string, fallback: T): T {
			let entry = cache.get(key);
			if (entry === undefined) {
				let raw: string | null;
				try {
					const storage = getLocalStorage();
					if (storage === undefined) throw new Error("localStorage is unavailable");
					raw = storage.getItem(prefix + key);
				} catch (error) {
					if (!readFailureLogged) {
						readFailureLogged = true;
						log.warn(`cannot read storage; using defaults: ${describeError(error)}`);
					}
					return fallback;
				}
				entry = { present: false, value: undefined };
				if (raw !== null) {
					try {
						entry = { present: true, value: JSON.parse(raw) };
					} catch {
						log.warn(`ignoring malformed JSON in storage key "${key}"`);
					}
				}
				cache.set(key, entry);
			}
			return entry.present ? (entry.value as T) : fallback;
		},

		set(key: string, value: unknown): void {
			let raw: string | undefined;
			try {
				raw = JSON.stringify(value);
			} catch (error) {
				log.error(`cannot store "${key}": value is not JSON-serializable: ${describeError(error)}`);
				return;
			}
			try {
				const storage = getLocalStorage();
				if (storage === undefined) throw new Error("localStorage is unavailable");
				if (raw === undefined) storage.removeItem(prefix + key);
				else storage.setItem(prefix + key, raw);
			} catch (error) {
				log.error(`cannot persist "${key}"; keeping it for this session only: ${describeError(error)}`);
			}
			// Cache the JSON round-trip, i.e. exactly what a reload would read back.
			cache.set(key, raw === undefined ? { present: false, value: undefined } : { present: true, value: JSON.parse(raw) });
			notify(key);
		},

		subscribe(key: string, listener: () => void): () => void {
			let keyListeners = listeners.get(key);
			if (keyListeners === undefined) {
				keyListeners = new Set();
				listeners.set(key, keyListeners);
			}
			keyListeners.add(listener);
			return () => {
				keyListeners.delete(listener);
				if (keyListeners.size === 0 && listeners.get(key) === keyListeners) listeners.delete(key);
			};
		},
	});
}

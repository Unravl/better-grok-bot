import { STORAGE_PREFIX, type PluginLogger } from "../sdk/index.ts";
import { describeError } from "./logger.ts";

export const MIGRATED_FLAG = `${STORAGE_PREFIX}__migrated-grok-mods`;
const GROK_MODS_KEY = /^grok-mods:([^:]+):(.+)$/s;

/**
 * Once per profile, copies every grok-mods plugin value `grok-mods:<id>:<key>` to
 * `bgb:<id>:<key>`, never overwriting a value Better Grok Bot already has.
 */
export function migrateGrokModsStorage(storage: Storage | undefined, log: PluginLogger): void {
	if (storage === undefined) return;
	try {
		if (storage.getItem(MIGRATED_FLAG) === "1") return;
		const keys: string[] = [];
		for (let index = 0; index < storage.length; index++) {
			const key = storage.key(index);
			if (key !== null) keys.push(key);
		}
		let copied = 0;
		for (const key of keys) {
			const match = GROK_MODS_KEY.exec(key);
			if (match === null) continue;
			const target = `${STORAGE_PREFIX}${match[1]}:${match[2]}`;
			const value = storage.getItem(key);
			if (value === null || storage.getItem(target) !== null) continue;
			storage.setItem(target, value);
			copied++;
		}
		storage.setItem(MIGRATED_FLAG, "1");
		if (copied > 0) log.info(`copied ${copied} grok-mods setting(s) to Better Grok Bot`);
	} catch (error) {
		log.warn(`could not migrate grok-mods settings: ${describeError(error)}`);
	}
}

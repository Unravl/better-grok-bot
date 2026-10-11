import { isValidSettingValue, type PluginSettings, type PluginStorage, type SettingField, type SettingValue } from "../sdk/index.ts";

/** Storage key holding setting `<name>` (inside the plugin's `bgb:<id>:` namespace). */
const settingKey = (name: string): string => `setting:${name}`;

/**
 * Schema-backed settings over a plugin's storage. `get` returns the stored value when it is valid
 * for its field (see `isValidSettingValue`), else the field default; `set` and `subscribe` reject
 * unknown keys, and `set` rejects invalid values, with `RangeError`.
 */
export function createSettings(pluginId: string, fields: Readonly<Record<string, SettingField>>, storage: PluginStorage): PluginSettings {
	const fieldFor = (key: string): SettingField => {
		const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
		if (field === undefined) throw new RangeError(`plugin ${pluginId} has no setting "${key}"`);
		return field;
	};

	return Object.freeze({
		get(key: string): SettingValue {
			const field = fieldFor(key);
			const stored: unknown = storage.get<unknown>(settingKey(key), undefined);
			return isValidSettingValue(field, stored) ? stored : field.default;
		},

		set(key: string, value: SettingValue): void {
			const field = fieldFor(key);
			if (!isValidSettingValue(field, value)) {
				throw new RangeError(`invalid value ${JSON.stringify(value)} for ${field.type} setting "${key}" of plugin ${pluginId}`);
			}
			storage.set(settingKey(key), value);
		},

		subscribe(key: string, listener: () => void): () => void {
			fieldFor(key);
			return storage.subscribe(settingKey(key), listener);
		},
	});
}

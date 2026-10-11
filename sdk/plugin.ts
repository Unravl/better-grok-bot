import { IDENTIFIER_PATTERN, type Permission, type Platform } from "./constants.ts";

/** Argument of a function replacer (core hooks and bundled plugins only). */
export interface PatchMatch {
	/** The whole match. */
	match: string;
	/** Capture groups 1..n (index 0 = group 1). */
	groups: readonly (string | undefined)[];
	named: Readonly<Record<string, string | undefined>>;
	offset: number;
	/** The whole file text the match was found in. */
	text: string;
	/** Renderer-relative path of that file (forward slashes). */
	file: string;
}

export interface Patch {
	id: string;
	/** Selects renderer-relative paths (forward slashes), e.g. `/^assets\/index-[\w-]+\.js$/`. */
	file: RegExp;
	/** `\i` matches a minified identifier. The `g` flag is forced. */
	find: RegExp;
	replace: string | ((m: PatchMatch) => string);
	/** Exact number of matches across all selected files. Default 1. */
	expect?: number;
}

export type SettingField =
	| { type: "boolean"; label: string; description?: string; default: boolean }
	| { type: "number"; label: string; description?: string; default: number; min?: number; max?: number; step?: number }
	| { type: "select"; label: string; description?: string; default: string; options: { value: string; label: string }[] }
	| { type: "string"; label: string; description?: string; default: string; placeholder?: string }
	/** A `KeyboardEvent.code`. */
	| { type: "key"; label: string; description?: string; default: string };

export interface PluginDefinition {
	id: string;
	name: string;
	description: string;
	version: string;
	authors?: string[];
	license?: string;
	homepage?: string;
	apiVersion: 1;
	platforms?: Platform[];
	permissions?: Permission[];
	settings?: Record<string, SettingField>;
	patches?: Patch[];
	/** Source path relative to the plugin dir. */
	runtime?: string;
	/** CSS path relative to the plugin dir. */
	styles?: string;
}

/** Identity helper giving `plugin.ts` files type checking. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
	return definition;
}

export interface SerializedRegExp {
	source: string;
	flags: string;
}

/** `plugin.json` of a community or dev plugin package, format 1. */
export interface PluginPackageJson {
	format: 1;
	id: string;
	name: string;
	description: string;
	version: string;
	authors: string[];
	license?: string;
	homepage?: string;
	apiVersion: 1;
	platforms?: Platform[];
	permissions: Permission[];
	settings: Record<string, SettingField>;
	patches: { id: string; file: SerializedRegExp; find: SerializedRegExp; replace: string; expect: number }[];
	runtime: "runtime.js" | null;
	styles: "styles.css" | null;
}

/** Rewrites each unescaped `\i` in `find` to {@link IDENTIFIER_PATTERN}, keeps the flags and forces `g`. */
export function compileFind(find: RegExp): RegExp {
	const source = find.source.replace(/(?<!\\)((?:\\\\)*)\\i/g, (_match, backslashes: string) => backslashes + IDENTIFIER_PATTERN);
	return new RegExp(source, find.flags.includes("g") ? find.flags : `${find.flags}g`);
}

export function serializeRegExp(regexp: RegExp): SerializedRegExp {
	return { source: regexp.source, flags: regexp.flags };
}

/** Throws `SyntaxError` for an invalid source or flags. */
export function deserializeRegExp(serialized: SerializedRegExp): RegExp {
	return new RegExp(serialized.source, serialized.flags);
}

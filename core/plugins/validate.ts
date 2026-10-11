import { stat } from "node:fs/promises";
import * as path from "node:path";
import {
	PERMISSIONS,
	PLATFORMS,
	type PluginDefinition,
	type PluginPackageJson,
	VERSION_PATTERN,
	compileFind,
	isReservedPluginId,
	isValidPluginId,
} from "../../sdk/index.ts";
import { BgbError, errorMessage } from "../errors.ts";

const KiB = 1024;
const MiB = 1024 * KiB;

/** Caps on a community/dev plugin package (`plugin.json` and its assets). */
export const PACKAGE_JSON_LIMITS = Object.freeze({
	pluginJsonBytes: 1 * MiB,
	patches: 200,
	regexSourceLength: 4 * KiB,
	replacementLength: 64 * KiB,
	runtimeBytes: 5 * MiB,
	stylesBytes: 2 * MiB,
});

const REGEX_FLAGS = "imsu";
const SETTING_TYPES: Record<string, true> = { boolean: true, number: true, select: true, string: true, key: true };

type Problems = string[];

/** The one plain-object guard for S1's hand-written boundary parsers (plugin.json, definitions, records). */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** `$\`` and `$'` copy the whole text before/after each match; every other `$` token is bounded. */
export function replacementProblem(replace: string): string | undefined {
	for (let i = 0; i < replace.length; i++) {
		if (replace[i] !== "$") continue;
		const next = replace[i + 1];
		if (next === "$") i++;
		else if (next === "`" || next === "'") return "replacements may not use $` or $'";
	}
	return undefined;
}

function checkOptionalString(value: unknown, label: string, problems: Problems): void {
	if (value !== undefined && typeof value !== "string") problems.push(`${label} must be a string`);
}

function checkSubset(value: unknown, allowed: readonly string[], label: string, problems: Problems): void {
	if (!isStringArray(value)) {
		problems.push(`${label} must be an array of strings`);
		return;
	}
	const unknown = value.filter((item) => !allowed.includes(item));
	if (unknown.length > 0) problems.push(`${label} has unknown value(s) ${unknown.join(", ")} (allowed: ${allowed.join(", ")})`);
	if (new Set(value).size !== value.length) problems.push(`${label} has duplicates`);
}

function checkSetting(name: string, field: unknown, problems: Problems): void {
	const label = `settings.${name}`;
	if (!isRecord(field)) {
		problems.push(`${label} must be an object`);
		return;
	}
	if (typeof field.type !== "string" || SETTING_TYPES[field.type] !== true) {
		problems.push(`${label}.type must be one of ${Object.keys(SETTING_TYPES).join(", ")}`);
		return;
	}
	if (typeof field.label !== "string" || field.label === "") problems.push(`${label}.label must be a non-empty string`);
	checkOptionalString(field.description, `${label}.description`, problems);
	const value = field.default;
	switch (field.type) {
		case "boolean":
			if (typeof value !== "boolean") problems.push(`${label}.default must be a boolean`);
			break;
		case "number": {
			for (const key of ["min", "max", "step"] as const) {
				if (field[key] !== undefined && (typeof field[key] !== "number" || !Number.isFinite(field[key]))) {
					problems.push(`${label}.${key} must be a finite number`);
				}
			}
			if (typeof value !== "number" || !Number.isFinite(value)) {
				problems.push(`${label}.default must be a finite number`);
				break;
			}
			if (typeof field.min === "number" && value < field.min) problems.push(`${label}.default is below min`);
			if (typeof field.max === "number" && value > field.max) problems.push(`${label}.default is above max`);
			break;
		}
		case "select": {
			const options = field.options;
			if (
				!Array.isArray(options) ||
				options.length === 0 ||
				!options.every((option) => isRecord(option) && typeof option.value === "string" && typeof option.label === "string")
			) {
				problems.push(`${label}.options must be a non-empty array of {value, label} strings`);
				break;
			}
			if (typeof value !== "string" || !options.some((option) => isRecord(option) && option.value === value)) {
				problems.push(`${label}.default must be one of its options`);
			}
			break;
		}
		case "string":
			if (typeof value !== "string") problems.push(`${label}.default must be a string`);
			checkOptionalString(field.placeholder, `${label}.placeholder`, problems);
			break;
		case "key":
			if (typeof value !== "string" || value === "") problems.push(`${label}.default must be a non-empty KeyboardEvent.code`);
			break;
	}
}

function checkSettings(settings: unknown, problems: Problems): void {
	if (!isRecord(settings)) {
		problems.push("settings must be an object");
		return;
	}
	for (const [name, field] of Object.entries(settings)) {
		if (name === "") problems.push("settings has an empty name");
		checkSetting(name, field, problems);
	}
}

/** Checks the fields shared by plugin definitions and packages (everything except patches and assets). */
function checkCommonFields(value: Record<string, unknown>, problems: Problems): void {
	if (typeof value.id !== "string" || !isValidPluginId(value.id)) {
		problems.push("id must be lowercase kebab-case, 2–48 characters");
	}
	if (typeof value.name !== "string" || value.name === "") problems.push("name must be a non-empty string");
	if (typeof value.description !== "string") problems.push("description must be a string");
	if (typeof value.version !== "string" || !VERSION_PATTERN.test(value.version)) {
		problems.push("version must be a semantic version (x.y.z)");
	}
	if (value.apiVersion !== 1) problems.push("apiVersion must be 1");
	checkOptionalString(value.license, "license", problems);
	checkOptionalString(value.homepage, "homepage", problems);
	if (value.platforms !== undefined) checkSubset(value.platforms, PLATFORMS, "platforms", problems);
}

function checkSerializedRegExp(value: unknown, label: string, expandIdentifiers: boolean, problems: Problems): void {
	if (!isRecord(value) || typeof value.source !== "string" || typeof value.flags !== "string") {
		problems.push(`${label} must be {source, flags} strings`);
		return;
	}
	if (value.source.length > PACKAGE_JSON_LIMITS.regexSourceLength) problems.push(`${label} source is longer than 4 KiB`);
	const flags = [...value.flags];
	if (flags.some((flag) => !REGEX_FLAGS.includes(flag)) || new Set(flags).size !== flags.length) {
		problems.push(`${label} flags must be a subset of "${REGEX_FLAGS}"`);
		return;
	}
	try {
		const regexp = new RegExp(value.source, value.flags);
		if (expandIdentifiers) compileFind(regexp);
	} catch (error) {
		problems.push(`${label} is not a valid regular expression: ${errorMessage(error)}`);
	}
}

function checkPackagePatches(patches: unknown, problems: Problems): void {
	if (!Array.isArray(patches)) {
		problems.push("patches must be an array");
		return;
	}
	if (patches.length > PACKAGE_JSON_LIMITS.patches) problems.push(`more than ${PACKAGE_JSON_LIMITS.patches} patches`);
	const seen = new Set<string>();
	patches.forEach((patch: unknown, index) => {
		if (!isRecord(patch)) {
			problems.push(`patches[${index}] must be an object`);
			return;
		}
		const label = typeof patch.id === "string" && patch.id !== "" ? `patch "${patch.id}"` : `patches[${index}]`;
		if (typeof patch.id !== "string" || patch.id === "") problems.push(`${label}: id must be a non-empty string`);
		else if (seen.has(patch.id)) problems.push(`duplicate patch id "${patch.id}"`);
		else seen.add(patch.id);
		checkSerializedRegExp(patch.file, `${label}: file`, false, problems);
		checkSerializedRegExp(patch.find, `${label}: find`, true, problems);
		if (typeof patch.replace !== "string") {
			problems.push(`${label}: replace must be a string`);
		} else {
			if (patch.replace.length > PACKAGE_JSON_LIMITS.replacementLength) problems.push(`${label}: replace is longer than 64 KiB`);
			const problem = replacementProblem(patch.replace);
			if (problem !== undefined) problems.push(`${label}: ${problem}`);
		}
		if (typeof patch.expect !== "number" || !Number.isInteger(patch.expect) || patch.expect < 0) {
			problems.push(`${label}: expect must be an integer ≥ 0`);
		}
	});
}

/** Sizes of a package's assets in bytes; `undefined` = the file does not exist. */
export interface PackageAssetSizes {
	runtimeBytes: number | undefined;
	stylesBytes: number | undefined;
}

/**
 * Validates `plugin.json` (format 1) against known asset sizes. Throws `BgbError("bad-request")` listing
 * every problem.
 */
export function validatePackageJson(json: unknown, assets: PackageAssetSizes): PluginPackageJson {
	const problems: Problems = [];
	if (!isRecord(json)) throw new BgbError("bad-request", "invalid plugin.json: expected a JSON object");
	if (Buffer.byteLength(JSON.stringify(json)) > PACKAGE_JSON_LIMITS.pluginJsonBytes) problems.push("plugin.json is larger than 1 MiB");
	if (json.format !== 1) problems.push("format must be 1");
	checkCommonFields(json, problems);
	if (typeof json.id === "string" && isReservedPluginId(json.id)) problems.push(`id "${json.id}" is reserved`);
	if (!isStringArray(json.authors)) problems.push("authors must be an array of strings");
	checkSubset(json.permissions, PERMISSIONS, "permissions", problems);
	checkSettings(json.settings, problems);
	checkPackagePatches(json.patches, problems);
	if (json.runtime !== null && json.runtime !== "runtime.js") problems.push('runtime must be "runtime.js" or null');
	else if (json.runtime === "runtime.js") {
		if (assets.runtimeBytes === undefined) problems.push("runtime.js is missing");
		else if (assets.runtimeBytes > PACKAGE_JSON_LIMITS.runtimeBytes) problems.push("runtime.js is larger than 5 MiB");
	}
	if (json.styles !== null && json.styles !== "styles.css") problems.push('styles must be "styles.css" or null');
	else if (json.styles === "styles.css") {
		if (assets.stylesBytes === undefined) problems.push("styles.css is missing");
		else if (assets.stylesBytes > PACKAGE_JSON_LIMITS.stylesBytes) problems.push("styles.css is larger than 2 MiB");
	}
	if (problems.length > 0) throw new BgbError("bad-request", `invalid plugin.json: ${problems.join("; ")}`);
	// Every field was checked above.
	return json as unknown as PluginPackageJson;
}

async function regularFileSize(file: string): Promise<number | undefined> {
	try {
		const info = await stat(file);
		return info.isFile() ? info.size : undefined;
	} catch {
		return undefined;
	}
}

/** Validates a package's parsed `plugin.json` and the `runtime.js`/`styles.css` it names inside `dir`. */
export async function validatePackage(json: unknown, dir: string): Promise<PluginPackageJson> {
	return validatePackageJson(json, {
		runtimeBytes: await regularFileSize(path.join(dir, "runtime.js")),
		stylesBytes: await regularFileSize(path.join(dir, "styles.css")),
	});
}

function checkDefinitionPatches(patches: unknown, problems: Problems): void {
	if (!Array.isArray(patches)) {
		problems.push("patches must be an array");
		return;
	}
	const seen = new Set<string>();
	patches.forEach((patch: unknown, index) => {
		if (!isRecord(patch)) {
			problems.push(`patches[${index}] must be an object`);
			return;
		}
		const label = typeof patch.id === "string" && patch.id !== "" ? `patch "${patch.id}"` : `patches[${index}]`;
		if (typeof patch.id !== "string" || patch.id === "") problems.push(`${label}: id must be a non-empty string`);
		else if (seen.has(patch.id)) problems.push(`duplicate patch id "${patch.id}"`);
		else seen.add(patch.id);
		if (!(patch.file instanceof RegExp)) problems.push(`${label}: file must be a RegExp`);
		if (!(patch.find instanceof RegExp)) {
			problems.push(`${label}: find must be a RegExp`);
		} else {
			try {
				compileFind(patch.find);
			} catch (error) {
				problems.push(`${label}: find is not a valid regular expression after \\i expansion: ${errorMessage(error)}`);
			}
		}
		if (typeof patch.replace !== "string" && typeof patch.replace !== "function") {
			problems.push(`${label}: replace must be a string or a function`);
		}
		if (patch.expect !== undefined && (typeof patch.expect !== "number" || !Number.isInteger(patch.expect) || patch.expect < 0)) {
			problems.push(`${label}: expect must be an integer ≥ 0`);
		}
	});
}

/**
 * Validates a `definePlugin` default export (core hooks, bundled plugins, author builds). Works for plain
 * objects too. Throws `BgbError("bad-request")` listing every problem.
 */
export function validateDefinition(def: unknown): PluginDefinition {
	if (!isRecord(def)) throw new BgbError("bad-request", "invalid plugin definition: expected a default-exported definePlugin({...}) object");
	const problems: Problems = [];
	checkCommonFields(def, problems);
	if (def.authors !== undefined && !isStringArray(def.authors)) problems.push("authors must be an array of strings");
	if (def.permissions !== undefined) checkSubset(def.permissions, PERMISSIONS, "permissions", problems);
	if (def.settings !== undefined) checkSettings(def.settings, problems);
	if (def.patches !== undefined) checkDefinitionPatches(def.patches, problems);
	checkOptionalString(def.runtime, "runtime", problems);
	checkOptionalString(def.styles, "styles", problems);
	if (problems.length > 0) throw new BgbError("bad-request", `invalid plugin definition${typeof def.id === "string" ? ` "${def.id}"` : ""}: ${problems.join("; ")}`);
	// Every field was checked above.
	return def as unknown as PluginDefinition;
}

import * as path from "node:path";
import {
	type PatchMatch,
	type PatchResult,
	type PluginPackageJson,
	compileFind,
	deserializeRegExp,
} from "../../sdk/index.ts";
import { errorMessage } from "../errors.ts";

const MiB = 1024 * 1024;

/**
 * Bounds on one community/dev plugin's patches, enforced in the worker while patching and re-checked on
 * the main thread. Text sizes are JS string lengths (UTF-16 code units); input is bytes on disk.
 */
export const PATCH_LIMITS = Object.freeze({
	/** Total size of the files a plugin's patches select. */
	inputBytes: 64 * MiB,
	/** Each edited file ≤ `growthFactor` × its length before the plugin + `growthSlack`. */
	growthFactor: 2,
	growthSlack: 1 * MiB,
	/** All of a plugin's edited files together. */
	totalEditLength: 128 * MiB,
});

export interface PatchLimits {
	readonly inputBytes: number;
	readonly growthFactor: number;
	readonly growthSlack: number;
	readonly totalEditLength: number;
}

/** One budget for selection, matching and replacement of one isolated plugin. */
export const PATCH_TIMEOUT_MS = 10_000;

export const LIMITS_ERROR = "patch output exceeds limits";
export const INPUT_LIMITS_ERROR = "patch input exceeds limits";
export const PROTECTED_ERROR = "community patches may not modify index.html or Better Grok Bot files";

/** `index.html` and everything BGB injects under `assets/bgb/` are off limits to community patches. */
export function isProtectedRendererPath(file: string): boolean {
	return file === "index.html" || file === "assets/bgb" || file.startsWith("assets/bgb/");
}

/** Whether an edited file of `editedLength` stays within limits of the file's `originalLength`. */
export function withinGrowthLimit(originalLength: number, editedLength: number, limits: PatchLimits): boolean {
	return editedLength <= limits.growthFactor * originalLength + limits.growthSlack;
}

/** A patch ready to run: `find` still contains `\i`; `expect` resolved. */
export interface EnginePatch {
	id: string;
	file: RegExp;
	find: RegExp;
	replace: string | ((match: PatchMatch) => string);
	expect: number;
}

export interface PatchAttempt {
	results: PatchResult[];
	errors: string[];
	/** Renderer-relative path → new text. Empty unless every patch succeeded. */
	edits: Map<string, string>;
}

/** Community mode: string replacements only, protected files, counting stops at `expect + 1`, limits. */
export interface IsolationGuard {
	limits: PatchLimits;
	/** Size in bytes of a renderer file as currently on disk. */
	size(file: string): number;
}

type ReplacementToken = string | { group: number } | { name: string };

/**
 * Parses a string replacement the way `String.prototype.replace` does (`$$`, `$&`, `$1`–`$99`,
 * `$<name>`); `` $` `` and `$'` throw. Used to size the output before replacing.
 */
export function parseReplacement(replace: string, groupCount: number, hasNamedGroups: boolean): ReplacementToken[] {
	const tokens: ReplacementToken[] = [];
	let literal = "";
	const flush = (): void => {
		if (literal !== "") tokens.push(literal);
		literal = "";
	};
	for (let i = 0; i < replace.length; i++) {
		const char = replace[i] ?? "";
		if (char !== "$" || i + 1 >= replace.length) {
			literal += char;
			continue;
		}
		const next = replace[i + 1] ?? "";
		if (next === "$") {
			literal += "$";
			i++;
		} else if (next === "&") {
			flush();
			tokens.push({ group: 0 });
			i++;
		} else if (next === "`" || next === "'") {
			throw new Error("replacements may not use $` or $'");
		} else if (next >= "0" && next <= "9") {
			const after = replace[i + 2] ?? "";
			const two = after >= "0" && after <= "9" ? Number(next + after) : -1;
			const one = Number(next);
			if (two >= 1 && two <= groupCount) {
				flush();
				tokens.push({ group: two });
				i += 2;
			} else if (one >= 1 && one <= groupCount) {
				flush();
				tokens.push({ group: one });
				i++;
			} else {
				literal += `$${next}`;
				i++;
			}
		} else if (next === "<" && hasNamedGroups) {
			const close = replace.indexOf(">", i + 2);
			if (close === -1) {
				literal += "$<";
				i++;
			} else {
				flush();
				tokens.push({ name: replace.slice(i + 2, close) });
				i = close;
			}
		} else {
			literal += "$";
		}
	}
	flush();
	return tokens;
}

function expandedLength(tokens: readonly ReplacementToken[], match: RegExpMatchArray): number {
	let length = 0;
	for (const token of tokens) {
		if (typeof token === "string") length += token.length;
		else if ("group" in token) length += match[token.group]?.length ?? 0;
		else length += match.groups?.[token.name]?.length ?? 0;
	}
	return length;
}

/**
 * Applies `patches` in order to the files named in `names`, reading each file once through `read`.
 * All-or-nothing: any failing patch empties `edits`. Each patch must match exactly `expect` times across
 * the files its `file` regex selects. With a `guard` (community/dev plugins in the worker) only string
 * replacements are allowed, protected files are rejected, counting stops at `expect + 1`, and the input
 * and output sizes are bounded by `guard.limits` before anything is replaced.
 */
export async function applyPatches(
	patches: readonly EnginePatch[],
	names: readonly string[],
	read: (file: string) => string | Promise<string>,
	guard?: IsolationGuard,
): Promise<PatchAttempt> {
	const edits = new Map<string, string>();
	const originalLengths = new Map<string, number>();
	const results: PatchResult[] = patches.map((patch) => ({ id: patch.id, files: [], matches: 0, expected: patch.expect, ok: false }));
	const errors: string[] = [];
	const current = async (file: string): Promise<string> => {
		const edited = edits.get(file);
		if (edited !== undefined) return edited;
		const text = await read(file);
		originalLengths.set(file, text.length);
		return text;
	};

	const selections = new Map<EnginePatch, string[]>();
	for (const patch of patches) {
		try {
			selections.set(
				patch,
				names.filter((file) => file.search(patch.file) !== -1),
			);
		} catch (error) {
			errors.push(`patch "${patch.id}": file pattern ${patch.file} failed: ${errorMessage(error)}`);
		}
	}
	if (guard !== undefined && errors.length === 0) {
		const selected = new Set([...selections.values()].flat());
		if ([...selected].some(isProtectedRendererPath)) {
			errors.push(PROTECTED_ERROR);
		} else {
			let total = 0;
			for (const file of selected) total += guard.size(file);
			if (total > guard.limits.inputBytes) errors.push(INPUT_LIMITS_ERROR);
		}
	}
	if (errors.length > 0) return { results, errors, edits: new Map() };

	for (const [index, patch] of patches.entries()) {
		const result = results[index];
		const selected = selections.get(patch);
		if (result === undefined || selected === undefined) continue;
		try {
			if (selected.length === 0) {
				errors.push(`patch "${patch.id}": file pattern ${patch.file} matched no renderer files`);
				continue;
			}
			const find = compileFind(patch.find);
			const replace = patch.replace;
			const limit = guard === undefined ? Number.POSITIVE_INFINITY : patch.expect + 1;
			// An empty alternative always matches, so the result length reveals the capture-group count.
			const groupCount = (new RegExp(`${find.source}|`, find.flags.replace("g", "")).exec("")?.length ?? 1) - 1;
			let tokens: ReplacementToken[] | undefined;
			if (guard !== undefined) {
				if (typeof replace !== "string") throw new Error("community plugins must use string replacements");
				tokens = parseReplacement(replace, groupCount, /\(\?<[^=!]/.test(find.source));
			}
			const counts: string[] = [];
			const texts = new Map<string, { text: string; length: number }>();
			for (const file of selected) {
				if (result.matches >= limit) break;
				const text = await current(file);
				let count = 0;
				let length = text.length;
				for (const match of text.matchAll(find)) {
					count++;
					if (tokens !== undefined) length += expandedLength(tokens, match) - match[0].length;
					if (result.matches + count >= limit) break;
				}
				if (count === 0) continue;
				texts.set(file, { text, length });
				result.files.push(file);
				result.matches += count;
				counts.push(`${file} (${count})`);
			}
			if (result.matches !== patch.expect) {
				const found = result.matches >= limit ? `more than ${patch.expect}` : String(result.matches);
				const where = counts.length > 0 ? counts.join(", ") : `${selected.length} file(s) matching ${patch.file}`;
				errors.push(`patch "${patch.id}": expected ${patch.expect} match(es) of ${patch.find}, found ${found} in ${where}`);
				continue;
			}
			if (guard !== undefined) {
				let total = 0;
				for (const [file, text] of edits) if (!texts.has(file)) total += text.length;
				for (const [file, { length }] of texts) {
					total += length;
					if (!withinGrowthLimit(originalLengths.get(file) ?? 0, length, guard.limits)) throw new Error(LIMITS_ERROR);
				}
				if (total > guard.limits.totalEditLength) throw new Error(LIMITS_ERROR);
			}
			for (const [file, { text }] of texts) {
				edits.set(
					file,
					typeof replace === "string"
						? text.replace(find, replace)
						: text.replace(find, (match: string, ...rest: unknown[]) => {
								const named = rest[groupCount + 2];
								const replacement = replace({
									match,
									groups: rest.slice(0, groupCount) as (string | undefined)[],
									named: (typeof named === "object" && named !== null ? named : {}) as Record<string, string | undefined>,
									offset: rest[groupCount] as number,
									text: rest[groupCount + 1] as string,
									file,
								});
								if (typeof replacement !== "string") throw new Error("replacer did not return a string");
								return replacement;
							}),
				);
			}
			result.ok = true;
		} catch (error) {
			errors.push(`patch "${patch.id}": ${errorMessage(error)}`);
		}
	}
	if (errors.length > 0) edits.clear();
	return { results, errors, edits };
}

/** Message posted to the patch worker. */
export interface IsolatedRequest {
	root: string;
	names: string[];
	patches: PluginPackageJson["patches"];
	limits: PatchLimits;
}

/** The worker's reply: changed files only, and none unless every patch succeeded. */
export interface IsolatedResponse {
	results: PatchResult[];
	errors: string[];
	edits: Record<string, string>;
}

/** Runs inside the patch worker: compiles the serialized regexes and patches the files under `root`. */
export async function runIsolatedRequest(request: IsolatedRequest): Promise<IsolatedResponse> {
	const patches: EnginePatch[] = [];
	for (const patch of request.patches) {
		try {
			patches.push({
				id: patch.id,
				file: deserializeRegExp(patch.file),
				find: deserializeRegExp(patch.find),
				replace: patch.replace,
				expect: patch.expect,
			});
		} catch (error) {
			return {
				results: request.patches.map((p) => ({ id: p.id, files: [], matches: 0, expected: p.expect, ok: false })),
				errors: [`patch "${patch.id}": ${errorMessage(error)}`],
				edits: {},
			};
		}
	}
	const fileOf = (name: string): string => path.join(request.root, ...name.split("/"));
	const attempt = await applyPatches(patches, request.names, (name) => Bun.file(fileOf(name)).text(), {
		limits: request.limits,
		size: (name) => Bun.file(fileOf(name)).size,
	});
	return { results: attempt.results, errors: attempt.errors, edits: Object.fromEntries(attempt.edits) };
}

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { definePlugin } from "../../sdk/index.ts";
import { BgbError } from "../errors.ts";
import { CORE_HOOKS } from "./core.ts";
import { replacementProblem, validateDefinition, validatePackage, validatePackageJson } from "./validate.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "bgb-validate-"));
	await writeFile(path.join(dir, "runtime.js"), "1");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function pkg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		format: 1,
		id: "good-plugin",
		name: "Good",
		description: "",
		version: "1.2.3-beta.1",
		authors: ["a"],
		apiVersion: 1,
		permissions: ["keys"],
		settings: {
			on: { type: "boolean", label: "On", default: true },
			level: { type: "number", label: "Level", default: 5, min: 0, max: 10, step: 1 },
			mode: { type: "select", label: "Mode", default: "a", options: [{ value: "a", label: "A" }] },
			key: { type: "key", label: "Key", default: "AltRight" },
		},
		patches: [{ id: "p", file: { source: "^assets/a\\.js$", flags: "" }, find: { source: "x(\\i)", flags: "i" }, replace: "$1$&$$", expect: 1 }],
		runtime: "runtime.js",
		styles: null,
		...overrides,
	};
}

async function problem(overrides: Record<string, unknown>): Promise<string> {
	try {
		await validatePackage(pkg(overrides), dir);
	} catch (error) {
		expect(error).toBeInstanceOf(BgbError);
		expect((error as BgbError).code).toBe("bad-request");
		return (error as Error).message;
	}
	throw new Error("expected validation to fail");
}

test("a well-formed package validates", async () => {
	expect((await validatePackage(pkg(), dir)).id).toBe("good-plugin");
});

test("every package rule is enforced", async () => {
	expect(await problem({ format: 2 })).toContain("format must be 1");
	expect(await problem({ apiVersion: 2 })).toContain("apiVersion must be 1");
	expect(await problem({ id: "bgb-react" })).toContain('id "bgb-react" is reserved');
	expect(await problem({ id: "Bad_Id" })).toContain("id must be lowercase kebab-case");
	expect(await problem({ version: "1.0" })).toContain("version must be a semantic version");
	expect(await problem({ authors: "me" })).toContain("authors must be an array of strings");
	expect(await problem({ platforms: ["darwin", "beos"] })).toContain("platforms has unknown value(s) beos");
	expect(await problem({ permissions: ["camera"] })).toContain("permissions has unknown value(s) camera");
	expect(await problem({ settings: { m: { type: "select", label: "M", default: "z", options: [{ value: "a", label: "A" }] } } })).toContain(
		"settings.m.default must be one of its options",
	);
	expect(await problem({ settings: { n: { type: "number", label: "N", default: 11, max: 10 } } })).toContain("settings.n.default is above max");
	expect(await problem({ settings: { n: { type: "number", label: "N", default: -1, min: 0 } } })).toContain("settings.n.default is below min");
	expect(await problem({ settings: { b: { type: "boolean", label: "B", default: "yes" } } })).toContain("settings.b.default must be a boolean");
	expect(await problem({ settings: { c: { type: "color", label: "C", default: "" } } })).toContain("settings.c.type must be one of");
	const patch = (over: Record<string, unknown>) => ({ patches: [{ id: "p", file: { source: "a", flags: "" }, find: { source: "b", flags: "" }, replace: "c", expect: 1, ...over }] });
	expect(await problem(patch({ find: { source: "b", flags: "g" } }))).toContain('find flags must be a subset of "imsu"');
	expect(await problem(patch({ file: { source: "(", flags: "" } }))).toContain("file is not a valid regular expression");
	expect(await problem(patch({ expect: 1.5 }))).toContain("expect must be an integer ≥ 0");
	expect(await problem(patch({ replace: "$`" }))).toContain("replacements may not use $` or $'");
	expect(await problem(patch({ replace: "a$'b" }))).toContain("replacements may not use $` or $'");
	expect(await problem(patch({ replace: 5 }))).toContain("replace must be a string");
	expect(
		await problem({
			patches: [
				{ id: "p", file: { source: "a", flags: "" }, find: { source: "b", flags: "" }, replace: "c", expect: 1 },
				{ id: "p", file: { source: "a", flags: "" }, find: { source: "b", flags: "" }, replace: "c", expect: 1 },
			],
		}),
	).toContain('duplicate patch id "p"');
	expect(await problem({ styles: "styles.css" })).toContain("styles.css is missing");
	expect(await problem({ runtime: "main.js" })).toContain('runtime must be "runtime.js" or null');
	await rm(path.join(dir, "runtime.js"));
	expect(await problem({})).toContain("runtime.js is missing");
});

test("size caps are enforced", async () => {
	const patches = Array.from({ length: 201 }, (_, i) => ({ id: `p${i}`, file: { source: "a", flags: "" }, find: { source: "b", flags: "" }, replace: "", expect: 0 }));
	expect(await problem({ patches })).toContain("more than 200 patches");
	const longFind = [{ id: "p", file: { source: "a", flags: "" }, find: { source: "b".repeat(4097), flags: "" }, replace: "", expect: 0 }];
	expect(await problem({ patches: longFind })).toContain("find source is longer than 4 KiB");
	const longReplace = [{ id: "p", file: { source: "a", flags: "" }, find: { source: "b", flags: "" }, replace: "r".repeat(64 * 1024 + 1), expect: 0 }];
	expect(await problem({ patches: longReplace })).toContain("replace is longer than 64 KiB");
	expect(await problem({ description: "d".repeat(1024 * 1024) })).toContain("plugin.json is larger than 1 MiB");
	expect(() => validatePackageJson(pkg(), { runtimeBytes: 5 * 1024 * 1024 + 1, stylesBytes: undefined })).toThrow("runtime.js is larger than 5 MiB");
	expect(() => validatePackageJson(pkg({ styles: "styles.css" }), { runtimeBytes: 1, stylesBytes: 2 * 1024 * 1024 + 1 })).toThrow(
		"styles.css is larger than 2 MiB",
	);
});

test("replacementProblem allows $$, $&, $n and $<name> but not $` or $'", () => {
	expect(replacementProblem("$$`$&$1$99$<x>")).toBeUndefined();
	expect(replacementProblem("$$$`")).toBe("replacements may not use $` or $'");
});

test("validateDefinition accepts the core hooks and reports bad definitions", () => {
	for (const hook of CORE_HOOKS) expect(validateDefinition(hook)).toBe(hook);
	expect(() => validateDefinition(undefined)).toThrow("expected a default-exported definePlugin");
	const bad = definePlugin({
		id: "x-y",
		name: "",
		description: "d",
		version: "1",
		apiVersion: 1,
		patches: [
			{ id: "a", file: /a/, find: /b/, replace: "c" },
			{ id: "a", file: /a/, find: /b/, replace: "c", expect: -1 },
		],
	});
	expect(() => validateDefinition(bad)).toThrow(
		'invalid plugin definition "x-y": name must be a non-empty string; version must be a semantic version (x.y.z); duplicate patch id "a"; patch "a": expect must be an integer ≥ 0',
	);
	expect(() => validateDefinition({ ...bad, name: "n", version: "1.0.0", patches: [{ id: "f", file: "a", find: /b/, replace: 1 }] })).toThrow(
		'patch "f": file must be a RegExp; patch "f": replace must be a string or a function',
	);
});

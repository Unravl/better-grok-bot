import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { PatchMatch, PluginPackageJson } from "../../sdk/index.ts";
import { PATCH_WORKER_URL } from "../context.ts";
import { settingsHook } from "../hooks/settings.ts";
import { PATCH_LIMITS, parseReplacement } from "./patch-engine.ts";
import { PatchWorkspace } from "./patch.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "bgb-patch-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function workspace(files: Record<string, string>): Promise<PatchWorkspace> {
	for (const [name, text] of Object.entries(files)) {
		const file = path.join(root, ...name.split("/"));
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, text);
	}
	return new PatchWorkspace(root, Object.keys(files));
}

function community(id: string, patches: { file: string; find: string; flags?: string; replace: string; expect?: number }[]): PluginPackageJson {
	return {
		format: 1,
		id,
		name: id,
		description: "",
		version: "1.0.0",
		authors: [],
		apiVersion: 1,
		permissions: [],
		settings: {},
		patches: patches.map((patch, index) => ({
			id: `p${index}`,
			file: { source: patch.file, flags: "" },
			find: { source: patch.find, flags: patch.flags ?? "" },
			replace: patch.replace,
			expect: patch.expect ?? 1,
		})),
		runtime: null,
		styles: null,
	};
}

const read = (name: string): Promise<string> => readFile(path.join(root, ...name.split("/")), "utf8");

test("\\i matches minified identifiers including $", async () => {
	const ws = await workspace({ "assets/a.js": "call(a$b,_x9)" });
	const attempt = await ws.attempt([{ id: "ids", file: /^assets\/a\.js$/, find: /call\((\i),(\i)\)/, replace: "call($2,$1)" }]);
	expect(attempt.errors).toEqual([]);
	expect(attempt.edits.get("assets/a.js")).toBe("call(_x9,a$b)");
});

test("expect counts matches across every selected file", async () => {
	const ws = await workspace({ "assets/a.js": "X", "assets/b.js": "X", "assets/c.css": "X" });
	const two = await ws.attempt([{ id: "x", file: /\.js$/, find: /X/, replace: "Y", expect: 2 }]);
	expect(two.errors).toEqual([]);
	expect([...two.edits.keys()].sort()).toEqual(["assets/a.js", "assets/b.js"]);
	expect(two.results[0]).toMatchObject({ matches: 2, expected: 2, ok: true, files: ["assets/a.js", "assets/b.js"] });

	const one = await ws.attempt([{ id: "x", file: /\.js$/, find: /X/, replace: "Y" }]);
	expect(one.errors).toEqual(['patch "x": expected 1 match(es) of /X/, found 2 in assets/a.js (1), assets/b.js (1)']);
	expect(one.edits.size).toBe(0);
});

test("a plugin's patches are all-or-nothing", async () => {
	const ws = await workspace({ "assets/a.js": "one two" });
	const attempt = await ws.attempt([
		{ id: "ok", file: /a\.js$/, find: /one/, replace: "1" },
		{ id: "miss", file: /a\.js$/, find: /three/, replace: "3" },
	]);
	expect(attempt.results.map((result) => result.ok)).toEqual([true, false]);
	expect(attempt.errors).toHaveLength(1);
	expect(attempt.edits.size).toBe(0);
	ws.commit(attempt.edits);
	await ws.flush();
	expect(await read("assets/a.js")).toBe("one two");
});

test("later plugins, in-process and isolated, see earlier edits", async () => {
	const ws = await workspace({ "assets/a.js": "alpha" });
	const first = await ws.attempt([{ id: "a", file: /a\.js$/, find: /alpha/, replace: "beta" }]);
	ws.commit(first.edits);

	const isolated = await ws.attemptIsolated(community("iso", [{ file: "a\\.js$", find: "beta", replace: "gamma" }]), {
		workerUrl: PATCH_WORKER_URL,
	});
	expect(isolated.errors).toEqual([]);
	expect(isolated.edits.get("assets/a.js")).toBe("gamma");
	ws.commit(isolated.edits);

	const third = await ws.attempt([{ id: "c", file: /a\.js$/, find: /gamma/, replace: "delta" }]);
	expect(third.errors).toEqual([]);
	ws.commit(third.edits);
	await ws.flush();
	expect(await read("assets/a.js")).toBe("delta");
});

test("function replacers receive groups, named groups, offset, text and file", async () => {
	const ws = await workspace({ "assets/a.js": "let x=foo(bar);" });
	const seen: PatchMatch[] = [];
	const attempt = await ws.attempt([
		{
			id: "fn",
			file: /a\.js$/,
			find: /(?<callee>\i)\((\i)\)/,
			replace: (m) => {
				seen.push(m);
				return `${m.groups[1]}(${m.named.callee})`;
			},
		},
	]);
	expect(attempt.errors).toEqual([]);
	expect(attempt.edits.get("assets/a.js")).toBe("let x=bar(foo);");
	expect(seen).toEqual([
		{ match: "foo(bar)", groups: ["foo", "bar"], named: { callee: "foo" }, offset: 6, text: "let x=foo(bar);", file: "assets/a.js" },
	]);
});

test("the bgb-settings core hook's function replacer works through PatchMatch", async () => {
	const chunk = [
		'const id="sand-settings-general";',
		"function G(){",
		"const z=a.jsx(xe,{title:t,children:c});",
		'a.jsx(se,{anchorId:"one"});a.jsx(se,{anchorId:"two"});',
		'a.jsx(Ce,{isChecked:i,isDisabled:d,label:l,onToggle:o,size:"md"});',
		'a.jsx(Pe,{"aria-label":q,disabled:w,onValueChange:v,options:p,placement:"bottom-end",size:"lg",value:z});',
		'a.jsx(ue,{onClick:k,size:"md",style:T.body2,type:"button",variant:"secondary"});',
		'return a.jsxs("div",{className:n,children:[d,o,r]})}',
	].join("");
	const ws = await workspace({ "assets/chunk-view-abc123.js": chunk, "assets/chunk-view-other.js": "nothing here" });
	const attempt = await ws.attempt(settingsHook.patches ?? []);
	expect(attempt.errors).toEqual([]);
	expect(attempt.edits.get("assets/chunk-view-abc123.js")).toContain(
		'children:[d,o,r,globalThis.BetterGrokBot?.settingsSection({Section:xe,Row:se,Toggle:Ce,Select:Pe,Button:ue,textStyles:T})??null]})}',
	);
});

test("an isolated plugin may not select index.html or assets/bgb", async () => {
	const ws = await workspace({ "index.html": "<script></script>", "assets/a.js": "a" });
	const attempt = await ws.attemptIsolated(community("bad", [{ file: "\\.(html|js)$", find: "script", replace: "x" }]), {
		workerUrl: PATCH_WORKER_URL,
	});
	expect(attempt.errors).toEqual(["community patches may not modify index.html or Better Grok Bot files"]);
	expect(attempt.edits.size).toBe(0);
});

test("isolated counting stops at expect + 1", async () => {
	const ws = await workspace({ "assets/a.js": "x".repeat(1000) });
	const attempt = await ws.attemptIsolated(community("many", [{ file: "a\\.js$", find: "x", replace: "y", expect: 3 }]), {
		workerUrl: PATCH_WORKER_URL,
	});
	expect(attempt.errors).toEqual(['patch "p0": expected 3 match(es) of /x/, found more than 3 in assets/a.js (4)']);
	expect(attempt.results[0]?.matches).toBe(4);
});

test("a catastrophic find regex times out in the worker and fails only that plugin", async () => {
	const files: Record<string, string> = { "assets/keep.js": "keep" };
	for (let i = 0; i < 8; i++) files[`assets/slow-${i}.js`] = `${"a".repeat(30)}b`;
	const ws = await workspace(files);
	const started = Date.now();
	const slow = await ws.attemptIsolated(community("slow", [{ file: "slow-", find: "(a+)+$", replace: "x" }]), {
		workerUrl: PATCH_WORKER_URL,
		timeoutMs: 1_000,
	});
	expect(slow.errors).toEqual(["patches timed out after 1 s"]);
	expect(slow.results.map((result) => result.ok)).toEqual([false]);
	expect(Date.now() - started).toBeLessThan(3_000);

	const next = await ws.attemptIsolated(community("next", [{ file: "keep", find: "keep", replace: "kept" }]), {
		workerUrl: PATCH_WORKER_URL,
	});
	expect(next.errors).toEqual([]);
	expect(next.edits.get("assets/keep.js")).toBe("kept");
});

test("a catastrophic file regex times out in the worker", async () => {
	const files: Record<string, string> = {};
	for (let i = 0; i < 8; i++) files[`assets/${"a".repeat(30)}b${i}.js`] = "z";
	const ws = await workspace(files);
	const attempt = await ws.attemptIsolated(community("slow-file", [{ file: "(a+)+$", find: "z", replace: "y" }]), {
		workerUrl: PATCH_WORKER_URL,
		timeoutMs: 1_000,
	});
	expect(attempt.errors).toEqual(["patches timed out after 1 s"]);
	expect(attempt.edits.size).toBe(0);
});

test("output beyond PATCH_LIMITS fails only that plugin", async () => {
	const ws = await workspace({ "assets/a.js": "x".repeat(20), "assets/b.js": "b" });
	const big = await ws.attemptIsolated(
		community("big", [{ file: "a\\.js$", find: "x", replace: "y".repeat(64 * 1024), expect: 20 }]),
		{ workerUrl: PATCH_WORKER_URL },
	);
	expect(big.errors).toEqual(['patch "p0": patch output exceeds limits']);
	expect(big.edits.size).toBe(0);

	const tight = { ...PATCH_LIMITS, growthSlack: 0, growthFactor: 1 };
	const grown = await ws.attemptIsolated(community("grow", [{ file: "b\\.js$", find: "b", replace: "bb" }]), {
		workerUrl: PATCH_WORKER_URL,
		limits: tight,
	});
	expect(grown.errors).toEqual(['patch "p0": patch output exceeds limits']);

	const small = await ws.attemptIsolated(community("small", [{ file: "b\\.js$", find: "b", replace: "c" }]), {
		workerUrl: PATCH_WORKER_URL,
	});
	expect(small.errors).toEqual([]);
});

test("selected input beyond PATCH_LIMITS is rejected before reading", async () => {
	const ws = await workspace({ "assets/a.js": "x".repeat(100) });
	const attempt = await ws.attemptIsolated(community("input", [{ file: "a\\.js$", find: "x", replace: "y", expect: 100 }]), {
		workerUrl: PATCH_WORKER_URL,
		limits: { ...PATCH_LIMITS, inputBytes: 50 },
	});
	expect(attempt.errors).toEqual(["patch input exceeds limits"]);
});

test("parseReplacement follows String.prototype.replace substitution rules", () => {
	expect(parseReplacement("a$$b$&c$1$10$2$<n>$x", 10, true)).toEqual([
		"a$b",
		{ group: 0 },
		"c",
		{ group: 1 },
		{ group: 10 },
		{ group: 2 },
		{ name: "n" },
		"$x",
	]);
	expect(parseReplacement("$10$3$<n>", 1, false)).toEqual([{ group: 1 }, "0$3$<n>"]);
	expect(() => parseReplacement("$`", 0, false)).toThrow("replacements may not use $` or $'");
	expect(() => parseReplacement("x$'", 0, false)).toThrow();
});

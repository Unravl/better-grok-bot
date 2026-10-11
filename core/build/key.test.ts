import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type PatchMatch, type PluginDefinition, type PluginPackageJson, definePlugin } from "../../sdk/index.ts";
import { readPackageContents } from "../plugins/community.ts";
import type { LoadedPlugin } from "../plugins/types.ts";
import { type BuildKeyInput, computeBuildKey } from "./key.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "bgb-key-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function bundled(definition: PluginDefinition, runtimeJs?: string): LoadedPlugin {
	return {
		id: definition.id,
		source: "bundled",
		definition,
		pkg: undefined,
		runtimeJs,
		stylesCss: undefined,
		enabled: true,
		granted: [],
		errors: [],
		state: undefined,
	};
}

function community(contents: { pkg: PluginPackageJson; runtimeJs: string | undefined; stylesCss: string | undefined }): LoadedPlugin {
	return {
		id: contents.pkg.id,
		source: "community",
		definition: undefined,
		...contents,
		enabled: true,
		granted: [],
		errors: [],
		state: undefined,
	};
}

function packageJson(overrides: Partial<PluginPackageJson> = {}): PluginPackageJson {
	return {
		format: 1,
		id: "demo",
		name: "Demo",
		description: "",
		version: "1.0.0",
		authors: [],
		apiVersion: 1,
		permissions: [],
		settings: {},
		patches: [],
		runtime: "runtime.js",
		styles: "styles.css",
		...overrides,
	};
}

function plugin(patch: { find: RegExp; replace: string | ((m: PatchMatch) => string) }): PluginDefinition {
	return definePlugin({
		id: "sample",
		name: "Sample",
		description: "",
		version: "1.0.0",
		apiVersion: 1,
		patches: [{ id: "p", file: /^assets\/a\.js$/, find: patch.find, replace: patch.replace }],
	});
}

function input(plugins: LoadedPlugin[], overrides: Partial<BuildKeyInput> = {}): BuildKeyInput {
	return {
		bgbVersion: "0.1.0",
		embedHash: "e".repeat(64),
		platform: "darwin",
		appFingerprint: "a".repeat(64),
		buildsDir: "/data/builds",
		bridgePort: 39320,
		bridgeToken: "token",
		plugins,
		themes: [],
		...overrides,
	};
}

test("a bundled patch's regex or replacement changes the key; an identical definition does not", () => {
	const base = computeBuildKey(input([bundled(plugin({ find: /a(\i)/, replace: "b$1" }))]));
	expect(computeBuildKey(input([bundled(plugin({ find: /a(\i)/, replace: "b$1" }))]))).toBe(base);
	expect(computeBuildKey(input([bundled(plugin({ find: /a(\i)x/, replace: "b$1" }))]))).not.toBe(base);
	expect(computeBuildKey(input([bundled(plugin({ find: /a(\i)/i, replace: "b$1" }))]))).not.toBe(base);
	expect(computeBuildKey(input([bundled(plugin({ find: /a(\i)/, replace: "c$1" }))]))).not.toBe(base);
	const fn = computeBuildKey(input([bundled(plugin({ find: /a(\i)/, replace: (m) => m.match }))]));
	expect(fn).not.toBe(base);
	expect(computeBuildKey(input([bundled(plugin({ find: /a(\i)/, replace: (m) => m.match.toUpperCase() }))]))).not.toBe(fn);
	expect(computeBuildKey(input([bundled(plugin({ find: /a(\i)/, replace: "b$1" }), "runtime")]))).not.toBe(base);
});

test("a package plugin's key covers the plugin.json, runtime and styles discovery read, not its directory as it is now", async () => {
	await writeFile(path.join(dir, "plugin.json"), JSON.stringify(packageJson()));
	await writeFile(path.join(dir, "runtime.js"), "console.log(1)");
	await writeFile(path.join(dir, "styles.css"), ".a{}");
	const discovered = await readPackageContents(dir);
	const base = computeBuildKey(input([community(discovered)]));

	// The package is replaced on disk after discovery: the key still describes the bytes the build assembles.
	await writeFile(path.join(dir, "runtime.js"), "console.log(2)");
	await writeFile(path.join(dir, "styles.css"), ".b{}");
	await writeFile(path.join(dir, "README.md"), "not assembled");
	expect(computeBuildKey(input([community(discovered)]))).toBe(base);

	expect(computeBuildKey(input([community(await readPackageContents(dir))]))).not.toBe(base);
	expect(computeBuildKey(input([community({ ...discovered, runtimeJs: "console.log(2)" })]))).not.toBe(base);
	expect(computeBuildKey(input([community({ ...discovered, stylesCss: ".b{}" })]))).not.toBe(base);
	expect(computeBuildKey(input([community({ ...discovered, pkg: packageJson({ description: "changed" }) })]))).not.toBe(base);

	// Texts are length-delimited, so moving bytes from one asset into the next never yields the same key.
	const split = computeBuildKey(input([community({ ...discovered, runtimeJs: "x\0styles y", stylesCss: undefined })]));
	expect(computeBuildKey(input([community({ ...discovered, runtimeJs: "x", stylesCss: "y\0styles -" })]))).not.toBe(split);
});

test("EMBED_HASH, platform, app, builds dir and theme inputs are part of the key", () => {
	const base = computeBuildKey(input([]));
	for (const overrides of [
		{ embedHash: "f".repeat(64) },
		{ platform: "linux" as const },
		{ appFingerprint: "b".repeat(64) },
		{ buildsDir: "/elsewhere/builds" },
		{ themes: [{ id: "t", enabled: false, bytes: new Uint8Array([1]) }] },
	]) {
		expect(computeBuildKey(input([], overrides))).not.toBe(base);
	}
	const theme = computeBuildKey(input([], { themes: [{ id: "t", enabled: false, bytes: new Uint8Array([1]) }] }));
	expect(computeBuildKey(input([], { themes: [{ id: "t", enabled: false, bytes: new Uint8Array([2]) }] }))).not.toBe(theme);
	expect(computeBuildKey(input([], { themes: [{ id: "t", enabled: true, bytes: new Uint8Array([1]) }] }))).not.toBe(theme);
});

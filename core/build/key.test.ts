import { expect, test } from "bun:test";
import { type PatchMatch, type PluginDefinition, definePlugin } from "../../sdk/index.ts";
import type { LoadedPlugin } from "../plugins/types.ts";
import { type BuildKeyInput, computeBuildKey } from "./key.ts";

function bundled(definition: PluginDefinition, runtimeJs?: string): LoadedPlugin {
	return {
		id: definition.id,
		source: "bundled",
		definition,
		pkg: undefined,
		dir: undefined,
		runtimeJs,
		stylesCss: undefined,
		enabled: true,
		granted: [],
		errors: [],
		state: undefined,
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

test("a bundled patch's regex or replacement changes the key; an identical definition does not", async () => {
	const base = await computeBuildKey(input([bundled(plugin({ find: /a(\i)/, replace: "b$1" }))]));
	expect(await computeBuildKey(input([bundled(plugin({ find: /a(\i)/, replace: "b$1" }))]))).toBe(base);
	expect(await computeBuildKey(input([bundled(plugin({ find: /a(\i)x/, replace: "b$1" }))]))).not.toBe(base);
	expect(await computeBuildKey(input([bundled(plugin({ find: /a(\i)/i, replace: "b$1" }))]))).not.toBe(base);
	expect(await computeBuildKey(input([bundled(plugin({ find: /a(\i)/, replace: "c$1" }))]))).not.toBe(base);
	const fn = await computeBuildKey(input([bundled(plugin({ find: /a(\i)/, replace: (m) => m.match }))]));
	expect(fn).not.toBe(base);
	expect(await computeBuildKey(input([bundled(plugin({ find: /a(\i)/, replace: (m) => m.match.toUpperCase() }))]))).not.toBe(fn);
	expect(await computeBuildKey(input([bundled(plugin({ find: /a(\i)/, replace: "b$1" }), "runtime")]))).not.toBe(base);
});

test("EMBED_HASH, platform, app, builds dir and theme inputs are part of the key", async () => {
	const base = await computeBuildKey(input([]));
	for (const overrides of [
		{ embedHash: "f".repeat(64) },
		{ platform: "linux" as const },
		{ appFingerprint: "b".repeat(64) },
		{ buildsDir: "/elsewhere/builds" },
		{ themes: [{ id: "t", enabled: false, bytes: new Uint8Array([1]) }] },
	]) {
		expect(await computeBuildKey(input([], overrides))).not.toBe(base);
	}
	const theme = await computeBuildKey(input([], { themes: [{ id: "t", enabled: false, bytes: new Uint8Array([1]) }] }));
	expect(await computeBuildKey(input([], { themes: [{ id: "t", enabled: false, bytes: new Uint8Array([2]) }] }))).not.toBe(theme);
	expect(await computeBuildKey(input([], { themes: [{ id: "t", enabled: true, bytes: new Uint8Array([1]) }] }))).not.toBe(theme);
});

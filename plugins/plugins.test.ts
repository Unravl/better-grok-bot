import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import type { BunPlugin } from "bun";
import { CORE_HOOKS } from "../core/hooks/index.ts";
import outputDevice from "./output-device/plugin.ts";
import pushToTalk from "./push-to-talk/plugin.ts";
import startup from "./startup/plugin.ts";
import voiceKeepalive from "./voice-keepalive/plugin.ts";
import {
	type BetterGrokBotRuntime,
	compileFind,
	isReservedPluginId,
	isValidPluginId,
	type Patch,
	type PatchMatch,
	PERMISSIONS,
	type PluginDefinition,
	VERSION_PATTERN,
} from "../sdk/index.ts";

const PLUGINS_DIR = import.meta.dir;
const SDK_ENTRY = path.join(PLUGINS_DIR, "..", "sdk", "index.ts");
/** A pristine extracted Grok Bot renderer; the real-renderer checks run only where it exists. */
const RENDERER_DIR = "/tmp/grok-app/dist/renderer";

/** The four grok-mods mods, each in the folder named by its id. */
const plugins: { dir: string; definition: PluginDefinition }[] = [
	{ dir: path.join(PLUGINS_DIR, "output-device"), definition: outputDevice },
	{ dir: path.join(PLUGINS_DIR, "push-to-talk"), definition: pushToTalk },
	{ dir: path.join(PLUGINS_DIR, "startup"), definition: startup },
	{ dir: path.join(PLUGINS_DIR, "voice-keepalive"), definition: voiceKeepalive },
];
const ids = plugins.map((plugin) => plugin.definition.id);

test("every plugin folder holds one of the bundled plugins", () => {
	const folders = readdirSync(PLUGINS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	expect(folders).toEqual(plugins.map((plugin) => path.basename(plugin.dir)));
});

describe.each(plugins)("$definition.id definition", ({ dir, definition }) => {
	const folder = path.basename(dir);

	test("id equals the folder and is a valid, unreserved plugin id", () => {
		expect(definition.id).toBe(folder);
		expect(isValidPluginId(definition.id)).toBe(true);
		expect(isReservedPluginId(definition.id)).toBe(false);
	});

	test("declares API version 1, a version and only known permissions", () => {
		expect(definition.apiVersion).toBe(1);
		expect(definition.version).toMatch(VERSION_PATTERN);
		for (const permission of definition.permissions ?? []) expect(PERMISSIONS).toContain(permission);
	});

	test("its runtime (and styles, when declared) exist beside plugin.ts", () => {
		expect(definition.runtime).toBe("runtime.ts");
		expect(existsSync(path.join(dir, definition.runtime ?? ""))).toBe(true);
		if (definition.styles !== undefined) expect(existsSync(path.join(dir, definition.styles))).toBe(true);
	});

	test("patches have unique ids, valid expect counts and compilable finds", () => {
		const patches = definition.patches ?? [];
		expect(patches.length).toBeGreaterThan(0);
		expect(new Set(patches.map((patch) => patch.id)).size).toBe(patches.length);
		for (const patch of patches) {
			const expected = patch.expect ?? 1;
			expect(Number.isInteger(expected) && expected >= 0).toBe(true);
			expect(compileFind(patch.find).flags).toContain("g");
		}
	});
});

/** Applies one compiled patch to `text`, handing function replacers a {@link PatchMatch}. */
function replaceAll(text: string, file: string, find: RegExp, replace: Patch["replace"]): string {
	if (typeof replace === "string") return text.replace(find, replace);
	const groupCount = (new RegExp(`${find.source}|`, find.flags).exec("")?.length ?? 1) - 1;
	return text.replace(find, (match: string, ...rest: unknown[]) => {
		const named = rest[groupCount + 2];
		return replace({
			match,
			groups: rest.slice(0, groupCount) as (string | undefined)[],
			named: typeof named === "object" && named !== null ? (named as Record<string, string | undefined>) : {},
			offset: rest[groupCount] as number,
			text: rest[groupCount + 1] as string,
			file,
		});
	});
}

interface PatchOutcome {
	plugin: string;
	patch: string;
	matches: number;
	expected: number;
}

interface RendererRun {
	outcomes: PatchOutcome[];
	edited: Map<string, string>;
}

/**
 * Runs every core hook (in order), then every bundled plugin (by id) over the real renderer in
 * memory, committing a plugin's edits only when all its patches match, as the build does: later
 * plugins see earlier edits. Nothing is written to disk.
 */
async function patchRealRenderer(): Promise<RendererRun> {
	const files = readdirSync(RENDERER_DIR, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.relative(RENDERER_DIR, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
		.sort();
	const committed = new Map<string, string>();
	const read = async (file: string): Promise<string> =>
		committed.get(file) ?? (await Bun.file(path.join(RENDERER_DIR, ...file.split("/"))).text());
	const outcomes: PatchOutcome[] = [];
	for (const definition of [...CORE_HOOKS, ...plugins.map((plugin) => plugin.definition)]) {
		const edits = new Map<string, string>();
		let complete = true;
		for (const patch of definition.patches ?? []) {
			const find = compileFind(patch.find);
			const expected = patch.expect ?? 1;
			let matches = 0;
			const texts = new Map<string, string>();
			for (const file of files.filter((candidate) => patch.file.test(candidate))) {
				const text = edits.get(file) ?? (await read(file));
				const count = Array.from(text.matchAll(find)).length;
				if (count === 0) continue;
				matches += count;
				texts.set(file, text);
			}
			outcomes.push({ plugin: definition.id, patch: patch.id, matches, expected });
			if (matches !== expected) {
				complete = false;
				continue;
			}
			for (const [file, text] of texts) edits.set(file, replaceAll(text, file, find, patch.replace));
		}
		if (complete) for (const [file, text] of edits) committed.set(file, text);
	}
	return { outcomes, edited: committed };
}

describe.skipIf(!existsSync(path.join(RENDERER_DIR, "index.html")))("patches against the real Grok Bot renderer", () => {
	// Lazy: Bun runs a skipped describe's body too, and an eager run would reject without the renderer.
	let pending: Promise<RendererRun> | undefined;
	const run = (): Promise<RendererRun> => (pending ??= patchRealRenderer());

	test.each([...CORE_HOOKS.map((hook) => hook.id), ...ids])("%s: every patch matches exactly its expect count", async (id) => {
		const { outcomes } = await run();
		const mine = outcomes.filter((outcome) => outcome.plugin === id);
		expect(mine.length).toBeGreaterThan(0);
		expect(mine.filter((outcome) => outcome.matches !== outcome.expected)).toEqual([]);
	});

	test("every patched file still parses as JavaScript", async () => {
		const { edited } = await run();
		const transpiler = new Bun.Transpiler({ loader: "js" });
		const unparsable: string[] = [];
		for (const [file, text] of edited) {
			if (!file.endsWith(".js")) continue;
			try {
				transpiler.scan(text);
			} catch (error) {
				unparsable.push(`${file}: ${String(error)}`);
			}
		}
		expect(edited.size).toBeGreaterThan(0);
		expect(unparsable).toEqual([]);
	});
});

/** Resolves `@better-grok-bot/sdk` to the repository SDK, as the plugin build does. */
const sdkShim: BunPlugin = {
	name: "bgb-sdk",
	setup(build) {
		build.onResolve({ filter: /^@better-grok-bot\/sdk$/ }, () => ({ path: SDK_ENTRY }));
	},
};

describe.each(plugins)("$definition.id runtime", ({ dir, definition }) => {
	test("bundles to a browser IIFE that registers under the plugin id", async () => {
		const result = await Bun.build({
			entrypoints: [path.join(dir, definition.runtime ?? "")],
			target: "browser",
			format: "iife",
			plugins: [sdkShim],
		});
		expect(result.logs.filter((log) => log.level === "error").map(String)).toEqual([]);
		expect(result.success).toBe(true);
		const [output] = result.outputs;
		if (output === undefined) throw new Error("no bundle output");
		const code = await output.text();
		const defined: string[] = [];
		const fake: Pick<BetterGrokBotRuntime, "define"> = { define: (id) => void defined.push(id) };
		globalThis.BetterGrokBot = fake as BetterGrokBotRuntime;
		try {
			new Function(code)();
		} finally {
			globalThis.BetterGrokBot = undefined;
		}
		expect(defined).toEqual([definition.id]);
	});
});

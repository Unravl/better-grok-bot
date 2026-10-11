import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { computeBuildKey } from "../build/key.ts";
import { runEmbed } from "./embed.ts";

const CHECKOUT = path.join(import.meta.dir, "..", "..");

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "bgb-embed-"));
	for (const tree of ["sdk", "core/app", "core/build", "core/plugins", "core/hooks", "core/patch-worker.ts", "loader", "plugins"]) {
		const from = path.join(CHECKOUT, ...tree.split("/"));
		if (existsSync(from)) await cp(from, path.join(root, ...tree.split("/")), { recursive: true });
	}
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function embedHash(): Promise<string> {
	return (await runEmbed({ root, allowMissing: true, dev: false })).embedHash;
}

async function generated(): Promise<string> {
	return readFile(path.join(root, "core", "generated", "embedded.ts"), "utf8");
}

test("writes every export with the SDK sources and the SDK bundled as ESM", async () => {
	const result = await runEmbed({ root, allowMissing: true, dev: false });
	const text = await generated();
	for (const name of ["LOADER_JS", "BUNDLED_RUNTIMES", "BUNDLED_STYLES", "SDK_SOURCES", "SDK_SHIM_SOURCE", "EMBED_HASH"]) {
		expect(text).toContain(`export const ${name}`);
	}
	expect(text).toContain(`export const EMBED_HASH: string = "${result.embedHash}";`);
	expect(text).toContain('"index.ts":');
	expect(text).toMatch(/export const SDK_SHIM_SOURCE: string = ".*definePlugin/);
	expect(await embedHash()).toBe(result.embedHash);
});

test("EMBED_HASH changes when only a core hook's find or replace changes, and the build key with it", async () => {
	const before = await embedHash();
	const hook = path.join(root, "core", "hooks", "react.ts");
	const source = await readFile(hook, "utf8");
	await writeFile(hook, source.replace("provideReact($2),$2)}", "provideReact($2),$2) }"));
	const replaced = await embedHash();
	expect(replaced).not.toBe(before);
	await writeFile(hook, source.replace("\\.useTransition=function", "\\.useTransition =function"));
	const found = await embedHash();
	expect(found).not.toBe(before);
	expect(found).not.toBe(replaced);
	await writeFile(hook, source);
	expect(await embedHash()).toBe(before);

	await writeFile(path.join(root, "core", "hooks", "react.test.ts"), "// tests are not part of the hash");
	expect(await embedHash()).toBe(before);

	const key = (hash: string) =>
		computeBuildKey({
			bgbVersion: "0.1.0",
			embedHash: hash,
			platform: "darwin",
			appFingerprint: "a",
			buildsDir: "/b",
			bridgePort: 1,
			bridgeToken: "t",
			plugins: [],
			themes: [],
		});
	expect(key(replaced)).not.toBe(key(before));
});

test("strict mode fails on a missing loader or runtime; --allow-missing skips them with warnings", async () => {
	await rm(path.join(root, "loader"), { recursive: true, force: true });
	await mkdir(path.join(root, "plugins", "demo"), { recursive: true });
	await writeFile(path.join(root, "plugins", "demo", "plugin.ts"), "export default {};");
	await expect(runEmbed({ root, allowMissing: false, dev: false })).rejects.toThrow("loader/index.ts is missing");
	const loose = await runEmbed({ root, allowMissing: true, dev: false });
	expect(loose.warnings).toEqual(["loader/index.ts is missing; LOADER_JS is empty", "plugins/demo/runtime.ts is missing; no runtime embedded for demo"]);
	expect(await generated()).toContain('export const LOADER_JS: string = "";');

	await mkdir(path.join(root, "loader"), { recursive: true });
	await writeFile(path.join(root, "loader", "index.ts"), 'import { RUNTIME_GLOBAL } from "../sdk/index.ts";\nconsole.log(RUNTIME_GLOBAL);\n');
	await writeFile(path.join(root, "plugins", "demo", "runtime.ts"), 'import { BOOT_GLOBAL } from "@better-grok-bot/sdk";\nconsole.log(BOOT_GLOBAL);\n');
	await writeFile(path.join(root, "plugins", "demo", "styles.css"), ".demo{}");
	const strict = await runEmbed({ root, allowMissing: false, dev: false });
	expect(strict.warnings).toEqual([]);
	const text = await generated();
	expect(text).toMatch(/export const LOADER_JS: string = ".*BetterGrokBot/);
	expect(text).toMatch(/export const BUNDLED_RUNTIMES: Record<string, string> = \{.*"demo":".*__BGB_BOOT__/);
	// Sorted by id; the copied bundled plugins add their own entries around "demo".
	expect(text).toMatch(/export const BUNDLED_STYLES: Record<string, string> = \{(?:.*,)?"demo":"\.demo\{\}"[,}]/);
	expect(await readFile(path.join(root, "core", "generated", "plugins", "demo.css"), "utf8")).toBe(".demo{}");

	await writeFile(path.join(root, "plugins", "demo", "runtime.ts"), "export const = ;");
	await expect(runEmbed({ root, allowMissing: true, dev: false })).rejects.toThrow("bundling plugins/demo/runtime.ts failed");
});

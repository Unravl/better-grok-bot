/**
 * Generates `core/generated/embedded.ts`: the renderer loader and bundled plugin runtimes as IIFE
 * strings, bundled plugin styles, the SDK sources (for `bgb plugin new`), the SDK bundled as ESM (the
 * `@better-grok-bot/sdk` shim for plugin builds) and `EMBED_HASH`, which changes whenever any of those or
 * the build engine, core hooks or bundled plugin definitions change.
 *
 * Usage: bun core/scripts/embed.ts [--allow-missing] [--root <checkout>]
 * `--allow-missing` (slices before integration only) writes "" for a missing loader and skips plugins
 * without a runtime.ts; package scripts and CI never pass it.
 */
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";

export interface EmbedOptions {
	/** Checkout root (contains `sdk/`, `core/`, `loader/`, `plugins/`). */
	root: string;
	allowMissing: boolean;
	/** `BGB_DEV=1`: unminified bundles with inline source maps. */
	dev: boolean;
}

export interface EmbedResult {
	file: string;
	embedHash: string;
	warnings: string[];
}

/** Source trees covered by `EMBED_HASH` (besides the generated text); `*.test.ts` excluded. */
const HASHED_SOURCES = [
	"core/app/**/*",
	"core/build/**/*",
	"core/patch-worker.ts",
	"core/plugins/**/*",
	"core/hooks/**/*",
	"plugins/*/plugin.ts",
	"loader/**/*",
	"sdk/**/*",
];

function sdkResolver(root: string): BunPlugin {
	return {
		name: "bgb-sdk-resolver",
		setup(builder) {
			builder.onResolve({ filter: /^@better-grok-bot\/sdk$/ }, () => ({ path: path.join(root, "sdk", "index.ts") }));
		},
	};
}

async function bundle(entry: string, root: string, format: "iife" | "esm", dev: boolean): Promise<string> {
	const result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format,
		minify: format === "iife" && !dev,
		sourcemap: format === "iife" && dev ? "inline" : "none",
		plugins: [sdkResolver(root)],
		throw: false,
	});
	const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
	if (!result.success || output === undefined) {
		const relative = path.relative(root, entry).split(path.sep).join("/");
		throw new Error(`bundling ${relative} failed:\n${result.logs.map(String).join("\n") || "no output"}`);
	}
	return output.text();
}

function sortedRecord(entries: [string, string][]): Record<string, string> {
	return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export async function runEmbed(opts: EmbedOptions): Promise<EmbedResult> {
	const root = path.resolve(opts.root);
	const warnings: string[] = [];
	const missing = (message: string): void => {
		if (!opts.allowMissing) throw new Error(message);
		warnings.push(message);
	};

	const loaderEntry = path.join(root, "loader", "index.ts");
	let loaderJs = "";
	if (existsSync(loaderEntry)) loaderJs = await bundle(loaderEntry, root, "iife", opts.dev);
	else missing("loader/index.ts is missing; LOADER_JS is empty");

	const runtimes: [string, string][] = [];
	const styles: [string, string][] = [];
	const pluginsDir = path.join(root, "plugins");
	if (existsSync(pluginsDir)) {
		for (const id of (await readdir(pluginsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
			const dir = path.join(pluginsDir, id);
			if (!existsSync(path.join(dir, "plugin.ts"))) continue;
			const runtime = path.join(dir, "runtime.ts");
			if (existsSync(runtime)) runtimes.push([id, await bundle(runtime, root, "iife", opts.dev)]);
			else missing(`plugins/${id}/runtime.ts is missing; no runtime embedded for ${id}`);
			const css = path.join(dir, "styles.css");
			if (existsSync(css)) styles.push([id, await readFile(css, "utf8")]);
		}
	} else {
		missing("plugins/ is missing; no bundled plugin runtimes embedded");
	}

	const sdkDir = path.join(root, "sdk");
	const sdkSources: [string, string][] = [];
	for (const name of (await readdir(sdkDir)).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
		sdkSources.push([name, await readFile(path.join(sdkDir, name), "utf8")]);
	}
	if (!sdkSources.some(([name]) => name === "index.ts")) throw new Error("sdk/index.ts is missing");
	const sdkShim = await bundle(path.join(sdkDir, "index.ts"), root, "esm", opts.dev);

	const generated = {
		LOADER_JS: loaderJs,
		BUNDLED_RUNTIMES: sortedRecord(runtimes),
		BUNDLED_STYLES: sortedRecord(styles),
		SDK_SOURCES: sortedRecord(sdkSources),
		SDK_SHIM_SOURCE: sdkShim,
	};
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`generated\0${JSON.stringify(generated)}\0`);
	const sources = new Set<string>();
	for (const pattern of HASHED_SOURCES) {
		for await (const file of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
			const relative = file.split(path.sep).join("/");
			if (!relative.endsWith(".test.ts")) sources.add(relative);
		}
	}
	for (const relative of [...sources].sort()) {
		const content = await readFile(path.join(root, ...relative.split("/")));
		hasher.update(`source ${relative}\0${content.byteLength}\0`);
		hasher.update(content);
	}
	const embedHash = hasher.digest("hex");

	const outDir = path.join(root, "core", "generated");
	await rm(path.join(outDir, "plugins"), { recursive: true, force: true });
	await mkdir(path.join(outDir, "plugins"), { recursive: true });
	await writeFile(path.join(outDir, "loader.js"), loaderJs);
	for (const [id, js] of runtimes) await writeFile(path.join(outDir, "plugins", `${id}.js`), js);
	for (const [id] of styles) await copyFile(path.join(pluginsDir, id, "styles.css"), path.join(outDir, "plugins", `${id}.css`));
	const file = path.join(outDir, "embedded.ts");
	await writeFile(
		file,
		[
			"// Generated by core/scripts/embed.ts; do not edit (gitignored).",
			`export const LOADER_JS: string = ${JSON.stringify(generated.LOADER_JS)};`,
			`export const BUNDLED_RUNTIMES: Record<string, string> = ${JSON.stringify(generated.BUNDLED_RUNTIMES)};`,
			`export const BUNDLED_STYLES: Record<string, string> = ${JSON.stringify(generated.BUNDLED_STYLES)};`,
			`export const SDK_SOURCES: Record<string, string> = ${JSON.stringify(generated.SDK_SOURCES)};`,
			`export const SDK_SHIM_SOURCE: string = ${JSON.stringify(generated.SDK_SHIM_SOURCE)};`,
			`export const EMBED_HASH: string = ${JSON.stringify(embedHash)};`,
			"",
		].join("\n"),
	);
	return { file, embedHash, warnings };
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: { "allow-missing": { type: "boolean", default: false }, root: { type: "string" } },
		strict: true,
	});
	try {
		const result = await runEmbed({
			root: values.root ?? path.join(import.meta.dir, "..", ".."),
			allowMissing: values["allow-missing"] === true,
			dev: process.env.BGB_DEV === "1",
		});
		for (const warning of result.warnings) console.error(`embed: warning: ${warning}`);
		console.error(`embed: wrote ${path.relative(process.cwd(), result.file)} (EMBED_HASH ${result.embedHash.slice(0, 12)})`);
	} catch (error) {
		console.error(`embed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

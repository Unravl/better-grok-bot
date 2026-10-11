import type { BunPlugin } from "bun";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	type PluginDefinition,
	type PluginPackageJson,
	type SerializedRegExp,
	isReservedPluginId,
	isValidPluginId,
} from "../../sdk/index.ts";
import type { CoreContext } from "../context.ts";
import { BgbError, errorMessage } from "../errors.ts";
import { SDK_SHIM_SOURCE, SDK_SOURCES } from "../generated/embedded.ts";
import { BUNDLED_PLUGINS } from "./bundled.ts";
import { writeZip } from "./package.ts";
import { validateDefinition, validatePackageJson } from "./validate.ts";

/** A built community plugin package, ready to zip (`writePackage`) or install. */
export interface BuiltPackage {
	json: PluginPackageJson;
	runtimeJs?: string;
	stylesCss?: string;
}

const SDK_SPECIFIER = /^@better-grok-bot\/sdk$/;

/** Resolves `@better-grok-bot/sdk` to the SDK bundled into BGB, so plugin builds see the same values. */
const sdkShim: BunPlugin = {
	name: "bgb-sdk-shim",
	setup(builder) {
		builder.onResolve({ filter: SDK_SPECIFIER }, () => ({ path: "@better-grok-bot/sdk", namespace: "bgb-sdk" }));
		builder.onLoad({ filter: /.*/, namespace: "bgb-sdk" }, () => ({ contents: SDK_SHIM_SOURCE, loader: "js" }));
	},
};

async function bundle(entry: string, target: "bun" | "browser"): Promise<string> {
	const result = await Bun.build({
		entrypoints: [entry],
		target,
		format: target === "bun" ? "esm" : "iife",
		sourcemap: target === "bun" ? "none" : "inline",
		plugins: [sdkShim],
		throw: false,
	});
	const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
	if (!result.success || output === undefined) {
		throw new BgbError("bad-request", `${entry} failed to build: ${result.logs.map(String).join("\n") || "no output"}`);
	}
	return output.text();
}

/** A path from the definition, resolved inside the plugin dir. */
function insidePluginDir(dir: string, relative: string, field: string): string {
	const resolved = path.resolve(dir, relative);
	const rel = path.relative(dir, resolved);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new BgbError("bad-request", `${field} ${relative} is outside the plugin directory`);
	return resolved;
}

function serializePattern(regexp: RegExp): SerializedRegExp {
	// `g` is implied for `find` and meaningless for `file`; packages store neither.
	return { source: regexp.source, flags: regexp.flags.replace("g", "") };
}

/**
 * Evaluates `dir/plugin.ts` on this computer (trusted local source): bundles it with the SDK shim, writes
 * the module into a fresh `DATA/cache/author/<rand>/` dir (a compiled binary only imports files from
 * newly created dirs) and imports its default export.
 */
async function loadDefinition(ctx: CoreContext, dir: string): Promise<PluginDefinition> {
	const entry = path.join(dir, "plugin.ts");
	if (!(await Bun.file(entry).exists())) throw new BgbError("bad-request", `${dir} has no plugin.ts`);
	const code = await bundle(entry, "bun");
	const authorDir = path.join(ctx.paths.cache, "author");
	await mkdir(authorDir, { recursive: true });
	const outDir = await mkdtemp(path.join(authorDir, "build-"));
	try {
		const file = path.join(outDir, "plugin.mjs");
		await writeFile(file, code);
		let loaded: { default?: unknown };
		try {
			// The module is the author's freshly built plugin.ts; its path exists only at run time.
			loaded = await import(pathToFileURL(file).href);
		} catch (error) {
			throw new BgbError("bad-request", `plugin.ts failed to load: ${errorMessage(error)}`);
		}
		return validateDefinition(loaded.default);
	} finally {
		await rm(outDir, { recursive: true, force: true });
	}
}

/**
 * Builds `dir` into a community package: `plugin.json` from the definition (string replacements only),
 * `runtime.js` (IIFE, inline source map) and `styles.css`. Evaluates `plugin.ts` on the host.
 */
export async function buildPluginPackage(ctx: CoreContext, dir: string): Promise<BuiltPackage> {
	const root = path.resolve(dir);
	const def = await loadDefinition(ctx, root);
	if (isReservedPluginId(def.id) || BUNDLED_PLUGINS.some((plugin) => plugin.definition.id === def.id)) {
		throw new BgbError("bad-request", `plugin id "${def.id}" is reserved`);
	}
	const functionPatches = (def.patches ?? []).filter((patch) => typeof patch.replace !== "string").map((patch) => patch.id);
	if (functionPatches.length > 0) {
		throw new BgbError("bad-request", `community plugins must use string replacements (patch ${functionPatches.join(", ")})`);
	}
	const runtimeJs = def.runtime === undefined ? undefined : await bundle(insidePluginDir(root, def.runtime, "runtime"), "browser");
	let stylesCss: string | undefined;
	if (def.styles !== undefined) {
		const file = insidePluginDir(root, def.styles, "styles");
		try {
			stylesCss = await readFile(file, "utf8");
		} catch (error) {
			throw new BgbError("bad-request", `cannot read styles ${def.styles}: ${errorMessage(error)}`);
		}
	}
	const json: PluginPackageJson = {
		format: 1,
		id: def.id,
		name: def.name,
		description: def.description,
		version: def.version,
		authors: def.authors ?? [],
		...(def.license === undefined ? {} : { license: def.license }),
		...(def.homepage === undefined ? {} : { homepage: def.homepage }),
		apiVersion: 1,
		...(def.platforms === undefined ? {} : { platforms: def.platforms }),
		permissions: def.permissions ?? [],
		settings: def.settings ?? {},
		patches: (def.patches ?? []).map((patch) => ({
			id: patch.id,
			file: serializePattern(patch.file),
			find: serializePattern(patch.find),
			replace: patch.replace as string,
			expect: patch.expect ?? 1,
		})),
		runtime: runtimeJs === undefined ? null : "runtime.js",
		styles: stylesCss === undefined ? null : "styles.css",
	};
	validatePackageJson(json, {
		runtimeBytes: runtimeJs === undefined ? undefined : Buffer.byteLength(runtimeJs),
		stylesBytes: stylesCss === undefined ? undefined : Buffer.byteLength(stylesCss),
	});
	return { json, ...(runtimeJs === undefined ? {} : { runtimeJs }), ...(stylesCss === undefined ? {} : { stylesCss }) };
}

/** The package's files: `plugin.json` plus `runtime.js`/`styles.css` when present. */
export function packageFiles(built: BuiltPackage): Map<string, Uint8Array> {
	const encoder = new TextEncoder();
	const files = new Map<string, Uint8Array>([["plugin.json", encoder.encode(`${JSON.stringify(built.json, null, "\t")}\n`)]]);
	if (built.runtimeJs !== undefined) files.set("runtime.js", encoder.encode(built.runtimeJs));
	if (built.stylesCss !== undefined) files.set("styles.css", encoder.encode(built.stylesCss));
	return files;
}

/** Writes a `.bgbplugin` zip with `plugin.json` at its root. */
export async function writePackage(built: BuiltPackage, outFile: string): Promise<void> {
	await mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
	await writeFile(outFile, writeZip(packageFiles(built)));
}

function titleCase(id: string): string {
	return id
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/** Scaffolds a plugin project in `dir` (which must not exist or be empty) with the SDK sources vendored. */
export async function newPlugin(_ctx: CoreContext, id: string, dir: string): Promise<void> {
	if (!isValidPluginId(id)) throw new BgbError("bad-request", `plugin id "${id}" must be lowercase kebab-case, 2–48 characters`);
	if (isReservedPluginId(id) || BUNDLED_PLUGINS.some((plugin) => plugin.definition.id === id)) {
		throw new BgbError("bad-request", `plugin id "${id}" is reserved`);
	}
	const root = path.resolve(dir);
	const existing = await readdir(root).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	if (existing.length > 0) throw new BgbError("conflict", `${root} already exists and is not empty`);
	const name = titleCase(id);
	const files: Record<string, string> = {
		"plugin.ts": `import { definePlugin } from "@better-grok-bot/sdk";

export default definePlugin({
	id: ${JSON.stringify(id)},
	name: ${JSON.stringify(name)},
	description: "Describe what ${name} does.",
	version: "0.1.0",
	authors: [],
	apiVersion: 1,
	settings: {
		greeting: {
			type: "string",
			label: "Greeting",
			description: "Logged when the plugin starts.",
			default: "Hello from ${name}",
		},
	},
	// String patches only for community plugins. \`\\i\` matches a minified identifier; \`expect\` is exact.
	// Find anchors with: bgb renderer extract <dir>
	patches: [],
	runtime: "runtime.ts",
});
`,
		"runtime.ts": `import type { PluginContext } from "@better-grok-bot/sdk";

globalThis.BetterGrokBot?.define(${JSON.stringify(id)}, (ctx: PluginContext) => {
	ctx.log.info(String(ctx.settings.get("greeting")));
	const unsubscribe = ctx.settings.subscribe("greeting", () => ctx.log.info("greeting is now", ctx.settings.get("greeting")));
	return { unsubscribe };
});
`,
		"README.md": `# ${name}

A [Better Grok Bot](https://github.com/Unravl/better-grok-bot) plugin.

- \`bgb dev .\` — load this folder into Grok Bot and rebuild on every change.
- \`bgb plugin build . --out ${id}.bgbplugin\` — build the installable package.
- Publish the \`.bgbplugin\` as a GitHub release asset; users install it with \`bgb plugins install github:<owner>/<repo>\`.
`,
		"tsconfig.json": `${JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "ESNext",
					moduleResolution: "bundler",
					lib: ["ES2023", "DOM", "DOM.Iterable"],
					strict: true,
					noEmit: true,
					skipLibCheck: true,
					allowImportingTsExtensions: true,
					verbatimModuleSyntax: true,
					paths: { "@better-grok-bot/sdk": ["./bgb-sdk/index.ts"] },
				},
				include: ["*.ts", "bgb-sdk"],
			},
			null,
			"\t",
		)}\n`,
	};
	for (const [file, text] of Object.entries(SDK_SOURCES)) files[`bgb-sdk/${file}`] = text;
	await mkdir(path.join(root, "bgb-sdk"), { recursive: true });
	for (const [file, text] of Object.entries(files)) await writeFile(path.join(root, ...file.split("/")), text);
}

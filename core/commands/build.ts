// Build-engine modules load per command (literal specifiers, so the compiled binary bundles them).
import { cp, readdir, realpath } from "node:fs/promises";
import * as path from "node:path";
import { INJECT_DIR, type PluginStatus } from "../../sdk/index.ts";
import type { CheckReport } from "../build/check.ts";
import { readConfig } from "../config.ts";
import { UsageError, parseArgs, subcommand } from "./args.ts";
import { type CommandEnv, liveRendererKeys } from "./env.ts";

function printPlugins(env: CommandEnv, plugins: readonly PluginStatus[], warnings: readonly string[]): void {
	for (const plugin of plugins) {
		if (plugin.source === "core" && plugin.state === "active") continue;
		const mark = plugin.state === "active" ? "✓" : plugin.state === "disabled" || plugin.state === "unsupported-platform" ? "-" : "✗";
		env.io.out(`  ${mark} ${plugin.id} ${plugin.version} (${plugin.source}) — ${plugin.state}`);
		if (plugin.state === "disabled") continue;
		for (const error of plugin.errors) env.io.err(`      ${error.replaceAll("\n", "\n      ")}`);
	}
	for (const warning of warnings) env.io.err(`bgb: warning: ${warning}`);
}

export async function runBuild(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, {
		flags: { "--force": "boolean", "--app": "value", "--json": "boolean" },
		usage: "bgb build [--force] [--app <path>] [--json]",
	});
	const ctx = await env.context();
	const [{ build }, { resolveApp }] = await Promise.all([import("../build/index.ts"), import("../app/resolve.ts")]);
	const appPath = args.value("--app");
	const app = appPath === undefined ? undefined : await resolveApp(ctx, path.resolve(appPath));
	const outcome = await build(ctx, { force: args.has("--force"), app, protect: await liveRendererKeys(ctx) });
	const plugins: PluginStatus[] = outcome.manifest.plugins;
	if (args.has("--json")) {
		env.io.out(
			JSON.stringify(
				{
					key: outcome.key,
					dir: outcome.dir,
					plugins: plugins.map(({ id, source, state, errors }) => ({ id, source, state, errors })),
				},
				null,
				2,
			),
		);
		return 0;
	}
	env.io.out(`${outcome.cached ? "Up to date" : "Built"}: ${outcome.dir}`);
	env.io.out(`Grok Bot ${outcome.manifest.appVersion}, build ${outcome.key.slice(0, 12)}`);
	printPlugins(env, plugins, outcome.warnings);
	return 0;
}

/** Functions `runCheck` uses from other modules; a test seam. */
export interface CheckDeps {
	checkAsar(asarPath: string): Promise<CheckReport>;
}

/** Exit 0 when the asar is supported and every core/bundled plugin applies, else 3. */
export async function runCheck(env: CommandEnv, argv: readonly string[], deps?: CheckDeps): Promise<number> {
	const args = parseArgs(argv, {
		flags: { "--asar": "value", "--json": "boolean" },
		usage: "bgb check --asar <path> [--json]",
	});
	const asarPath = args.value("--asar");
	if (!asarPath) throw new UsageError("--asar <path> is required\nusage: bgb check --asar <path> [--json]");
	const checkAsar = deps?.checkAsar ?? (await import("../build/check.ts")).checkAsar;
	const report = await checkAsar(path.resolve(asarPath));
	if (args.has("--json")) {
		env.io.out(JSON.stringify(report, null, 2));
	} else {
		env.io.out(`${report.asar}: Grok Bot ${report.appVersion ?? "unknown version"}`);
		env.io.out(report.supported ? "  renderer override: supported" : `  renderer override: NOT supported (${report.error ?? "unknown reason"})`);
		for (const plugin of report.plugins) {
			env.io.out(`  ${plugin.state === "active" ? "✓" : "✗"} ${plugin.id} (${plugin.source}) — ${plugin.state}`);
			for (const patch of plugin.patches) {
				if (!patch.ok) env.io.out(`      patch ${patch.id}: ${patch.matches} match(es), expected ${patch.expected}`);
			}
			for (const error of plugin.errors) env.io.out(`      ${error}`);
		}
		env.io.out(report.ok ? "ok" : "FAILED");
	}
	return report.ok ? 0 : 3;
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
	try {
		return (await readdir(dir)).length === 0;
	} catch {
		return true;
	}
}

/** `bgb renderer extract <dir> [--patched]`: renderer files for anchor hunting. */
export async function runRenderer(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const usage = "bgb renderer extract <dir> [--patched]";
	const [, rest] = subcommand(argv, ["extract"], usage);
	const args = parseArgs(rest, { flags: { "--patched": "boolean" }, min: 1, usage });
	const dest = path.resolve(args.positionals[0] ?? "");
	if (!(await isEmptyOrMissing(dest))) throw new Error(`${dest} is not empty`);
	const ctx = await env.context();
	if (args.has("--patched")) {
		let source: string;
		try {
			source = path.join(await realpath(ctx.paths.current), "renderer");
		} catch {
			throw new Error("no current build; run: bgb build");
		}
		// boot.js carries the bridge token; anchor hunting never needs it.
		const bootJs = path.join(source, ...INJECT_DIR.split("/"), "boot.js");
		await cp(source, dest, { recursive: true, filter: (file) => file !== bootJs });
	} else {
		const [{ resolveApp }, { extractRenderer }] = await Promise.all([import("../app/resolve.ts"), import("../app/asar.ts")]);
		const app = await resolveApp(ctx, (await readConfig(ctx.paths)).appPath);
		await extractRenderer(ctx, app.asarPath, dest);
	}
	env.io.out(`Wrote the ${args.has("--patched") ? "patched" : "pristine"} Grok Bot renderer to ${dest}.`);
	env.io.out("Never share or commit these files: they are Grok Bot's code.");
	return 0;
}

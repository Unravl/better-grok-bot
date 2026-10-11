// Other slices' modules load per command (literal specifiers, so the compiled binary bundles them):
// `bgb --version` and `bgb check` stay light, and each command loads only what it uses.
import { isReservedPluginId, type Permission, type PluginStatus } from "../../sdk/index.ts";
import { mutateConfig, readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { BgbError, errorMessage } from "../errors.ts";
import type { LoadedPlugin } from "../plugins/types.ts";
import { readState } from "../state.ts";
import { parseArgs, subcommand } from "./args.ts";
import { type CommandEnv, PERMISSION_MEANINGS, applyHint, confirmAction } from "./env.ts";

const USAGE =
	"bgb plugins [list] | enable <id> | disable <id> | install <source> [--yes] | uninstall <id> | update [<id>] [--yes]";

function printPermissions(env: CommandEnv, permissions: readonly Permission[]): void {
	for (const permission of permissions) env.io.out(`  • ${permission}: ${PERMISSION_MEANINGS[permission]}`);
}

async function discover(ctx: CoreContext): Promise<LoadedPlugin[]> {
	const { discoverPlugins } = await import("../plugins/discover.ts");
	return (await discoverPlugins(ctx, await readConfig(ctx.paths), ctx.platform.id)).plugins;
}

/** Plugin states of the last build, by id. */
async function lastBuildStates(ctx: CoreContext): Promise<Map<string, PluginStatus>> {
	const { lastBuild } = await readState(ctx.paths);
	if (!lastBuild) return new Map();
	const { readBuildManifest } = await import("../build/index.ts");
	const manifest = await readBuildManifest(ctx, lastBuild.key, lastBuild.appVersion);
	return new Map((manifest?.plugins ?? []).map((plugin: PluginStatus) => [plugin.id, plugin]));
}

async function list(env: CommandEnv): Promise<number> {
	const ctx = await env.context();
	const [plugins, built] = await Promise.all([discover(ctx), lastBuildStates(ctx)]);
	for (const plugin of plugins) {
		// A plugin enabled since the last build has no meaningful built state yet.
		const status = built.get(plugin.id);
		const result = status && status.state !== "disabled" ? status : undefined;
		const state = plugin.state ?? result?.state ?? "not built yet";
		const version = plugin.definition?.version ?? plugin.pkg?.version ?? "?";
		const mark = state === "active" ? "✓" : state === "disabled" || state === "unsupported-platform" ? "-" : state === "not built yet" ? "·" : "✗";
		const error = plugin.errors[0] ?? (plugin.state === undefined ? result?.errors[0] : undefined);
		env.io.out(`${mark} ${plugin.id} ${version} (${plugin.source}) — ${state}${error ? `: ${error}` : ""}`);
	}
	if (plugins.length === 0) env.io.out("(no plugins)");
	return 0;
}

async function setEnabled(env: CommandEnv, id: string, enabled: boolean): Promise<number> {
	if (isReservedPluginId(id)) throw new Error(`${id} is a core plugin; it is always enabled`);
	const ctx = await env.context();
	if (!(await discover(ctx)).some((plugin) => plugin.id === id)) throw new BgbError("not-found", `no plugin with id ${id}`);
	await mutateConfig(ctx.paths, (config) => {
		const others = config.disabledPlugins.filter((disabled) => disabled !== id);
		config.disabledPlugins = enabled ? others : [...others, id];
	});
	env.io.out(`${enabled ? "Enabled" : "Disabled"} ${id}. ${await applyHint(ctx)}`);
	return 0;
}

async function install(env: CommandEnv, source: string, yes: boolean): Promise<number> {
	const ctx = await env.context();
	const { inspectSource, installInspected } = await import("../plugins/install.ts");
	const { inspectionId, json, replaces } = await inspectSource(ctx, source);
	env.io.out(`${json.name} ${json.version} (${json.id})${json.authors.length > 0 ? ` by ${json.authors.join(", ")}` : ""}`);
	if (json.description) env.io.out(`  ${json.description}`);
	if (replaces) env.io.out(`  Replaces the installed version ${replaces.version}.`);
	env.io.out("Plugins run inside Grok Bot and can read everything it shows. Install only plugins you trust.");
	if (json.permissions.length > 0) {
		env.io.out("It asks to:");
		printPermissions(env, json.permissions);
	}
	const question = json.permissions.length > 0 ? "Allow?" : `Install ${json.name}?`;
	if (!(await confirmAction(question, yes))) {
		env.io.out("Not installed.");
		return 1;
	}
	const { id } = await installInspected(ctx, inspectionId, { acceptPermissions: json.permissions });
	env.io.out(`Installed ${id} ${json.version}. ${await applyHint(ctx)}`);
	return 0;
}

async function uninstall(env: CommandEnv, id: string): Promise<number> {
	const ctx = await env.context();
	const { uninstallPlugin } = await import("../plugins/install.ts");
	await uninstallPlugin(ctx, id);
	env.io.out(`Uninstalled ${id}. ${await applyHint(ctx)}`);
	return 0;
}

async function update(env: CommandEnv, only: string | undefined, yes: boolean): Promise<number> {
	const ctx = await env.context();
	const { installInspected, updatePlugin } = await import("../plugins/install.ts");
	const ids = only ? [only] : (await discover(ctx)).filter((plugin) => plugin.source === "community").map((plugin) => plugin.id);
	if (ids.length === 0) {
		env.io.out("No community plugins installed.");
		return 0;
	}
	let failed = 0;
	let changed = false;
	for (const id of ids) {
		try {
			const result = await updatePlugin(ctx, id);
			if (result.state === "current") {
				env.io.out(`${id}: up to date`);
				continue;
			}
			if (result.state === "updated") {
				env.io.out(`${id}: updated to ${result.version}`);
				changed = true;
				continue;
			}
			env.io.out(`${id} ${result.version} asks for new permissions:`);
			printPermissions(env, result.added);
			if (!(await confirmAction("Allow?", yes))) {
				env.io.out(`${id}: not updated`);
				continue;
			}
			const granted = (await readConfig(ctx.paths)).grants[id] ?? [];
			await installInspected(ctx, result.inspectionId, {
				acceptPermissions: [...new Set<Permission>([...granted, ...result.added])],
			});
			env.io.out(`${id}: updated to ${result.version}`);
			changed = true;
		} catch (error) {
			if (only) throw error;
			env.io.err(`bgb: ${id}: ${errorMessage(error)}`);
			failed++;
		}
	}
	if (changed) env.io.out(await applyHint(ctx));
	return failed > 0 ? 1 : 0;
}

export async function runPlugins(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const [sub, rest] = subcommand(argv, ["list", "enable", "disable", "install", "uninstall", "update"], USAGE, "list");
	switch (sub) {
		case "list":
			parseArgs(rest, { usage: "bgb plugins [list]" });
			return list(env);
		case "enable":
		case "disable": {
			const [id = ""] = parseArgs(rest, { min: 1, usage: `bgb plugins ${sub} <id>` }).positionals;
			return setEnabled(env, id, sub === "enable");
		}
		case "install": {
			const args = parseArgs(rest, { flags: { "--yes": "boolean" }, min: 1, usage: "bgb plugins install <source> [--yes]" });
			return install(env, args.positionals[0] ?? "", args.has("--yes"));
		}
		case "uninstall": {
			const [id = ""] = parseArgs(rest, { min: 1, usage: "bgb plugins uninstall <id>" }).positionals;
			return uninstall(env, id);
		}
		default: {
			const args = parseArgs(rest, { flags: { "--yes": "boolean" }, max: 1, usage: "bgb plugins update [<id>] [--yes]" });
			return update(env, args.positionals[0], args.has("--yes"));
		}
	}
}

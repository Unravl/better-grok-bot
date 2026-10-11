// Authoring and bridge modules load per command (literal specifiers, so the compiled binary bundles them).
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { isReservedPluginId, isValidPluginId } from "../../sdk/index.ts";
import { readLiveAgent, waitForAgent } from "../agent-record.ts";
import { readConfig } from "../config.ts";
import { errorMessage } from "../errors.ts";
import { parseArgs, subcommand } from "./args.ts";
import { type CommandEnv, confirmAction, installedBinary } from "./env.ts";
import { agentLogFile, followFile, interruptSignal } from "./logs.ts";

/** `bgb plugin new <id> [--dir <p>]` and `bgb plugin build [<dir>] [--out <file>]`. */
export async function runPlugin(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const [sub, rest] = subcommand(argv, ["new", "build"], "bgb plugin new <id> [--dir <path>] | bgb plugin build [<dir>] [--out <file>]");
	if (sub === "new") {
		const args = parseArgs(rest, { flags: { "--dir": "value" }, min: 1, usage: "bgb plugin new <id> [--dir <path>]" });
		const id = args.positionals[0] ?? "";
		if (!isValidPluginId(id)) throw new Error(`invalid plugin id "${id}": use 2–48 lowercase letters, digits and dashes`);
		if (isReservedPluginId(id)) throw new Error(`plugin id "${id}" is reserved for Better Grok Bot`);
		const dir = path.resolve(args.value("--dir") ?? id);
		const ctx = await env.context();
		const { newPlugin } = await import("../plugins/author.ts");
		await newPlugin(ctx, id, dir);
		env.io.out(`Created ${id} in ${dir}.`);
		env.io.out(`Try it live:   bgb dev ${dir}`);
		env.io.out(`Package it:    bgb plugin build ${dir}`);
		return 0;
	}
	const args = parseArgs(rest, { flags: { "--out": "value" }, max: 1, usage: "bgb plugin build [<dir>] [--out <file>]" });
	const dir = path.resolve(args.positionals[0] ?? ".");
	const ctx = await env.context();
	const { buildPluginPackage, writePackage } = await import("../plugins/author.ts");
	const built = await buildPluginPackage(ctx, dir);
	const out = path.resolve(args.value("--out") ?? path.join(dir, `${built.json.id}-${built.json.version}.bgbplugin`));
	await writePackage(built, out);
	env.io.out(`Wrote ${out}`);
	env.io.out(`Install it with: bgb plugins install ${out}`);
	return 0;
}

/**
 * `bgb dev <dir> [--yes]`: the agent builds `<dir>` as a dev plugin on every change while this command
 * runs and tails the agent log; Ctrl+C removes it again.
 */
export async function runDev(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, { flags: { "--yes": "boolean" }, min: 1, usage: "bgb dev <dir> [--yes]" });
	const dir = path.resolve(args.positionals[0] ?? "");
	const isDir = await stat(dir).then(
		(stats) => stats.isDirectory(),
		() => false,
	);
	if (!isDir) throw new Error(`${dir} is not a directory`);
	const question = `bgb dev runs ${path.join(dir, "plugin.ts")} on this computer with your user rights on every change. Continue?`;
	if (!(await confirmAction(question, args.has("--yes")))) return 1;

	const ctx = await env.context();
	const [{ buildPluginPackage }, dev] = await Promise.all([import("../plugins/author.ts"), import("../plugins/dev.ts")]);
	const built = await buildPluginPackage(ctx, dir);
	env.io.out(`Built ${built.json.id} ${built.json.version}.`);

	const log = agentLogFile(ctx.paths);
	const from = await stat(log).then(
		(stats) => stats.size,
		() => 0,
	);
	await dev.addDevDir(ctx, dir);
	const interrupt = interruptSignal();
	try {
		const config = await readConfig(ctx.paths);
		if (!(await readLiveAgent(ctx.paths))) {
			await ctx.platform.startAgent(installedBinary(ctx), ctx.paths);
			await waitForAgent(ctx.paths, config.bridgePort, { timeoutMs: 30_000 });
		}
		env.io.out(`Watching ${dir}; Grok Bot reloads after each rebuild. Press Ctrl+C to stop.`);
		await followFile(log, env.io.write, interrupt.signal, { from });
	} finally {
		interrupt.dispose();
		await dev.removeDevDir(ctx, dir);
		env.io.out(`Removed ${built.json.id} from the dev plugins.`);
	}
	// The agent's dev-plugins.json watcher rebuilds too; an explicit request makes the rebuild prompt.
	if (await readLiveAgent(ctx.paths)) {
		try {
			const { connectBridge } = await import("../bridge/client.ts");
			const client = await connectBridge(ctx.paths, { timeoutMs: 5_000 });
			try {
				await client.request("build.rebuild", {});
			} finally {
				client.close();
			}
		} catch (error) {
			env.io.err(`bgb: could not request a rebuild: ${errorMessage(error)}`);
		}
	}
	return 0;
}

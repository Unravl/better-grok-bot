// Agent and update modules load per command (literal specifiers, so the compiled binary bundles them).
import { readLiveAgent, waitForAgent } from "../agent-record.ts";
import { readConfig } from "../config.ts";
import { UsageError, parseArgs } from "./args.ts";
import { type CommandEnv, installedBinary } from "./env.ts";
import { describeUpdate } from "./status.ts";

export async function runStart(env: CommandEnv, argv: readonly string[]): Promise<number> {
	parseArgs(argv, { usage: "bgb start" });
	const ctx = await env.context();
	const live = await readLiveAgent(ctx.paths);
	if (live) {
		env.io.out(`The agent is already running (pid ${live.pid}, port ${live.port}).`);
		return 0;
	}
	const config = await readConfig(ctx.paths);
	await ctx.platform.startAgent(installedBinary(ctx), ctx.paths);
	const health = await waitForAgent(ctx.paths, config.bridgePort, { timeoutMs: 30_000 });
	env.io.out(`Started the agent ${health.version} (pid ${health.pid}, port ${config.bridgePort}).`);
	return 0;
}

export async function runStop(env: CommandEnv, argv: readonly string[]): Promise<number> {
	parseArgs(argv, { usage: "bgb stop" });
	const ctx = await env.context();
	const live = await readLiveAgent(ctx.paths);
	await ctx.platform.stopAgent(ctx.paths);
	env.io.out(
		live
			? `Stopped the agent (pid ${live.pid}). It starts again at the next login or with: bgb start`
			: "The agent is not running.",
	);
	return 0;
}

/** `bgb agent [--replace] [--self-test]`: the long-running background agent. */
export async function runAgentCommand(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, {
		flags: { "--replace": "boolean", "--self-test": "boolean" },
		usage: "bgb agent [--replace] [--self-test]",
	});
	const ctx = await env.context();
	const agent = await import("../agent/main.ts");
	return args.has("--self-test") ? agent.runSelfTest(ctx) : agent.runAgent(ctx, { replace: args.has("--replace") });
}

/** Hidden: run from `bin/previous/` after a self-update; restores the previous binaries if the new agent never gets healthy. */
export async function runWatchdog(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const usage = "bgb update-watchdog --expect <version> --timeout <seconds>";
	const args = parseArgs(argv, { flags: { "--expect": "value", "--timeout": "value" }, usage });
	const expect = args.value("--expect");
	const timeoutS = Number(args.value("--timeout"));
	if (!expect || !Number.isInteger(timeoutS) || timeoutS <= 0) {
		throw new UsageError(`--expect <version> and a positive integer --timeout <seconds> are required\nusage: ${usage}`);
	}
	const ctx = await env.context();
	const { runUpdateWatchdog } = await import("../update/self-update.ts");
	return runUpdateWatchdog(ctx, { expect, timeoutS });
}

/** `bgb update [--check]`: a live agent applies the update itself (and restarts); otherwise this process does. */
export async function runUpdate(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, { flags: { "--check": "boolean" }, usage: "bgb update [--check]" });
	const ctx = await env.context();
	const update = await import("../update/self-update.ts");
	if (args.has("--check")) {
		const status = await update.checkForUpdate(ctx);
		env.io.out(`Better Grok Bot ${status.current}: ${describeUpdate(status)}`);
		return status.state === "error" ? 1 : 0;
	}
	if (await readLiveAgent(ctx.paths)) {
		const { connectBridge } = await import("../bridge/client.ts");
		const client = await connectBridge(ctx.paths);
		try {
			const status = await client.request("update.check", {});
			if (status.state !== "available") {
				env.io.out(`Better Grok Bot ${status.current}: ${describeUpdate(status)}`);
				return status.state === "error" ? 1 : 0;
			}
			await client.request("update.apply", {});
			env.io.out(`The agent installed ${status.latest} and restarts on it; check with: bgb status`);
		} finally {
			client.close();
		}
		return 0;
	}
	const status = await update.applyUpdate(ctx, { restartAgent: false });
	env.io.out(`Better Grok Bot: ${describeUpdate(status)}`);
	return status.state === "error" ? 1 : 0;
}

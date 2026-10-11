/** `bgb agent [--replace] [--self-test]` entry points (Step 4.3). */
import { acquireAgentRecord } from "../agent-record.ts";
import { startBridge } from "../bridge/server.ts";
import { readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { runCommand } from "../services/command.ts";
import { readState } from "../state.ts";
import { BGB_VERSION } from "../version.ts";
import { Agent, type AgentDeps } from "./agent.ts";
import { loadCoreOps } from "./ops.ts";
import { respawnAgent, underLaunchd } from "./restart.ts";

/**
 * Runs the agent until it shuts down; resolves with the exit code. Exits 0 at once when another agent
 * of this `DATA` holds the singleton record (`--replace` first waits up to 15 s for it to exit).
 */
export async function runAgent(ctx: CoreContext, opts: { replace: boolean }, overrides: Partial<AgentDeps> = {}): Promise<number> {
	const config = await readConfig(ctx.paths);
	const ops = overrides.ops ?? (await loadCoreOps());
	const claim = await acquireAgentRecord(ctx.paths, { port: config.bridgePort, waitMs: opts.replace ? 15_000 : 0 });
	if (!("acquired" in claim)) {
		ctx.log.info(`agent already running (pid ${claim.owner.pid})`);
		return 0;
	}
	const deps: AgentDeps = {
		ops,
		run: runCommand,
		respawn: respawnAgent,
		underLaunchd: underLaunchd(),
		services: {},
		update: {},
		appPollMs: 10_000,
		updateIntervalMs: 6 * 60 * 60 * 1000,
		dataDebounceMs: 500,
		handleSignals: true,
		...overrides,
	};
	const agent = new Agent(ctx, deps, config, claim.release);
	try {
		await agent.start();
	} catch (error) {
		const message = errorMessage(error);
		ctx.log.error(message);
		console.error(`bgb: ${message}`);
		await agent.stop(false);
		return 1;
	}
	return agent.finished;
}

/**
 * `bgb agent --self-test` (run by self-update on a freshly installed binary): reads config and state,
 * serves `/health` on an ephemeral port and queries it. Never takes the singleton record, writes
 * state or touches helpers.
 */
export async function runSelfTest(ctx: CoreContext): Promise<number> {
	try {
		const config = await readConfig(ctx.paths);
		await readState(ctx.paths);
		const bridge = startBridge({ port: 0, token: config.bridgeToken, handlers: {}, log: ctx.log });
		try {
			const response = await fetch(`http://127.0.0.1:${bridge.port}/health`, { signal: AbortSignal.timeout(5_000) });
			const body: unknown = await response.json();
			if (typeof body !== "object" || body === null || !("version" in body) || body.version !== BGB_VERSION) {
				throw new Error(`/health answered ${JSON.stringify(body)}`);
			}
		} finally {
			await bridge.stop();
		}
		console.log(`ok ${BGB_VERSION}`);
		return 0;
	} catch (error) {
		console.error(`bgb: self-test failed: ${errorMessage(error)}`);
		return 1;
	}
}

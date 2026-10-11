import { type AgentRecord, readLiveAgent } from "../agent-record.ts";
import { readConfig } from "../config.ts";
import type { DataPaths } from "../paths.ts";
import { identityAlive } from "../proc.ts";

export interface StopAgentOptions {
	/**
	 * Replaces the `POST /shutdown` request (macOS: `launchctl bootout` of the agent job, which would
	 * otherwise be restarted by `KeepAlive`). Returning false falls back to the request.
	 */
	requestStop?: (record: AgentRecord) => Promise<boolean>;
	/** Last resort after SIGTERM (default: SIGKILL; Windows passes `taskkill /F /PID`). */
	killHard?: (pid: number) => Promise<void>;
	/** Defaults: 10 s after the stop request, 5 s after SIGTERM, 5 s after the hard kill. */
	gracefulMs?: number;
	termMs?: number;
	killMs?: number;
}

async function waitForIdentityExit(record: AgentRecord, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!(await identityAlive(record))) return true;
		if (Date.now() >= deadline) return false;
		await Bun.sleep(200);
	}
}

function signal(pid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(pid, sig);
	} catch {
		// Gone between the identity check and the signal.
	}
}

async function postShutdown(paths: DataPaths, record: AgentRecord): Promise<void> {
	let token: string;
	try {
		token = (await readConfig(paths)).bridgeToken;
	} catch {
		return;
	}
	try {
		await fetch(`http://127.0.0.1:${record.port}/shutdown`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(3_000),
		});
	} catch {
		// Unreachable bridge: the signals below still stop it.
	}
}

/**
 * Stops the agent of `paths`, if one runs: a graceful request (`POST /shutdown` with the bridge token,
 * or `requestStop`), then SIGTERM, then a hard kill. Each signal is sent only after re-checking that the
 * recorded process (pid + start time) still runs, so a reused pid is never signaled. Throws when the
 * agent survives everything.
 */
export async function stopAgentProcess(paths: DataPaths, opts: StopAgentOptions = {}): Promise<void> {
	const record = await readLiveAgent(paths);
	if (!record) return;
	const handled = opts.requestStop ? await opts.requestStop(record) : false;
	if (!handled) await postShutdown(paths, record);
	if (await waitForIdentityExit(record, opts.gracefulMs ?? 10_000)) return;

	if (!(await identityAlive(record))) return;
	signal(record.pid, "SIGTERM");
	if (await waitForIdentityExit(record, opts.termMs ?? 5_000)) return;

	if (!(await identityAlive(record))) return;
	if (opts.killHard) await opts.killHard(record.pid);
	else signal(record.pid, "SIGKILL");
	if (await waitForIdentityExit(record, opts.killMs ?? 5_000)) return;
	throw new Error(`the agent (pid ${record.pid}) did not stop`);
}

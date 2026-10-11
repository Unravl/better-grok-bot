import { readFile } from "node:fs/promises";
import { claimRecordFile, removeRecordFileIfUnchanged } from "./lock.ts";
import type { DataPaths } from "./paths.ts";
import { type ProcessIdentity, asProcessIdentity, identityAlive, selfIdentity } from "./proc.ts";
import { BGB_VERSION } from "./version.ts";

/** `DATA/agent.pid`: the singleton record of the running agent. */
export interface AgentRecord extends ProcessIdentity {
	version: string;
	port: number;
	/** ISO timestamp. */
	startedAt: string;
}

export interface AgentHealth {
	name: "better-grok-bot";
	version: string;
	pid: number;
}

export type AcquireResult = { acquired: true; record: AgentRecord; release(): Promise<void> } | { owner: AgentRecord };

function asAgentRecord(value: unknown): AgentRecord | undefined {
	const identity = asProcessIdentity(value);
	if (!identity) return undefined;
	const { version, port, startedAt } = value as Record<string, unknown>;
	if (typeof version !== "string" || typeof port !== "number" || typeof startedAt !== "string") return undefined;
	return { ...identity, version, port, startedAt };
}

/**
 * Claims `agent.pid` for this process. A record naming a dead process, or a live process with another
 * start time (pid reuse), is replaced without signaling anything. With a live owner, waits up to `waitMs`
 * for it to exit (`agent --replace`), then returns `{owner}`.
 */
export async function acquireAgentRecord(
	paths: DataPaths,
	opts: { port: number; waitMs?: number },
): Promise<AcquireResult> {
	const record: AgentRecord = {
		...(await selfIdentity()),
		version: BGB_VERSION,
		port: opts.port,
		startedAt: new Date().toISOString(),
	};
	const text = JSON.stringify(record);
	const deadline = Date.now() + (opts.waitMs ?? 0);
	for (;;) {
		const result = await claimRecordFile(paths.agentRecord, text);
		if (result.claimed) {
			return {
				acquired: true,
				record,
				release: () => removeRecordFileIfUnchanged(paths.agentRecord, text),
			};
		}
		const owner = asAgentRecord(result.holder);
		if (Date.now() >= deadline) {
			if (owner) return { owner };
			if (result.holder) throw new Error(`${paths.agentRecord} names a live process but is malformed`);
		}
		// An unparsable record is still being written; it becomes readable or stale shortly.
		await Bun.sleep(250);
	}
}

/** The running agent's record, or `null` when there is none or its process is gone. */
export async function readLiveAgent(paths: DataPaths): Promise<AgentRecord | null> {
	let text: string;
	try {
		text = await readFile(paths.agentRecord, "utf8");
	} catch {
		return null;
	}
	let record: AgentRecord | undefined;
	try {
		record = asAgentRecord(JSON.parse(text));
	} catch {
		return null;
	}
	return record && (await identityAlive(record)) ? record : null;
}

/**
 * Polls `GET http://127.0.0.1:<port>/health` every 250 ms until a BGB agent (of `version`, when given)
 * answers; throws after `timeoutMs`.
 */
export async function waitForAgent(
	paths: DataPaths,
	port: number,
	opts: { version?: string; timeoutMs: number },
): Promise<AgentHealth> {
	const deadline = Date.now() + opts.timeoutMs;
	let last = "no answer";
	for (;;) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
			const body = (await response.json()) as Partial<AgentHealth>;
			if (body.name === "better-grok-bot" && typeof body.version === "string" && typeof body.pid === "number") {
				if (opts.version === undefined || body.version === opts.version) {
					return { name: body.name, version: body.version, pid: body.pid };
				}
				last = `agent ${body.version} is running`;
			} else {
				last = "another program answered";
			}
		} catch {
			last = "no answer";
		}
		if (Date.now() >= deadline) {
			const wanted = opts.version === undefined ? "the agent" : `agent ${opts.version}`;
			throw new Error(`timed out waiting for ${wanted} on port ${port} (${last}; see ${paths.logs})`);
		}
		await Bun.sleep(250);
	}
}

import { errorMessage } from "../errors.ts";
import type { BuildOutcomeInfo } from "./ops.ts";

export type BuildResult = { ok: true; outcome: BuildOutcomeInfo } | { ok: false; error: string };

/**
 * Serializes agent builds and coalesces requests: a request made while a build runs is served by one
 * follow-up build that starts after it (forced if any coalesced request was forced).
 */
export class BuildScheduler {
	private readonly runBuild: (force: boolean) => Promise<BuildResult>;
	private next: { promise: Promise<BuildResult>; resolve(result: BuildResult): void } | null = null;
	private nextForce = false;
	private running: Promise<void> | null = null;
	private stopped = false;

	constructor(runBuild: (force: boolean) => Promise<BuildResult>) {
		this.runBuild = runBuild;
	}

	/** Resolves with the result of a build that starts after this call. */
	request(force = false): Promise<BuildResult> {
		if (this.stopped) return Promise.resolve({ ok: false, error: "agent stopping" });
		this.next ??= Promise.withResolvers<BuildResult>();
		this.nextForce ||= force;
		const { promise } = this.next;
		this.running ??= this.drain();
		return promise;
	}

	/** Resolves when no build is running. */
	async idle(): Promise<void> {
		while (this.running) await this.running;
	}

	/** No further builds start; queued requests resolve as failed. */
	stop(): void {
		this.stopped = true;
	}

	private async drain(): Promise<void> {
		try {
			while (this.next) {
				const waiter = this.next;
				const force = this.nextForce;
				this.next = null;
				this.nextForce = false;
				const result = this.stopped
					? { ok: false as const, error: "agent stopping" }
					: await this.runBuild(force).catch((error): BuildResult => ({ ok: false, error: errorMessage(error) }));
				waiter.resolve(result);
			}
		} finally {
			this.running = null;
		}
	}
}

import type { AgentToHelper, MediaState, Platform, ServiceStateInfo } from "../../sdk/index.ts";
import { BgbError } from "../errors.ts";

/** Validates `media.duck` params: a finite level from 0 to 1. */
export function parseDuckLevel(level: unknown): number {
	if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) {
		throw new BgbError("bad-request", "level must be a number from 0 to 1");
	}
	return level;
}

/** Per-connection duck requests; the effective level is the minimum, 1 = released. */
export class DuckLevels {
	private readonly byConnection = new Map<number, number>();

	/** Records one connection's level (`1` releases it); true when the effective level changed. */
	set(connectionId: number, level: number): boolean {
		const before = this.effective();
		if (level >= 1) this.byConnection.delete(connectionId);
		else this.byConnection.set(connectionId, level);
		return this.effective() !== before;
	}

	drop(connectionId: number): boolean {
		return this.set(connectionId, 1);
	}

	effective(): number {
		return Math.min(1, ...this.byConnection.values());
	}
}

/** The helper frame for an effective level (port of protocol v3: release = `{ducked:false, level:1}`). */
export function duckFrame(level: number): AgentToHelper {
	return level < 1 ? { type: "duck", ducked: true, level } : { type: "duck", ducked: false, level: 1 };
}

export interface MediaStateInput {
	platform: Platform;
	/** No helper is published for this OS/arch (macOS/Windows). */
	unsupportedReason: string | null;
	/** macOS: the helper LaunchAgent exists. */
	installed: boolean;
	/** `media` from the connected helper's latest hello (macOS/Windows), or `null` before one. */
	helperMedia: boolean | null;
	failures: number;
	maxFailures: number;
	lastFailure: string | null;
	/** Linux: the `pactl` probe result. */
	linux: ServiceStateInfo<MediaState>;
}

/** The `media.state` the agent reports (one source per OS, Step 4.7). */
export function computeMediaState(input: MediaStateInput): ServiceStateInfo<MediaState> {
	if (input.platform === "linux") return input.linux;
	if (input.unsupportedReason !== null) return { state: "unsupported", detail: input.unsupportedReason };
	if (input.platform === "darwin" && !input.installed) return { state: "needs-install" };
	if (input.platform === "win32" && input.failures >= input.maxFailures) {
		return { state: "error", detail: input.lastFailure ?? "the helper failed to start" };
	}
	if (input.helperMedia === false) return { state: "unsupported", detail: "the helper cannot control other apps' volume" };
	return { state: "ready" };
}

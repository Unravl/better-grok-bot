/**
 * Linux music ducking over `pactl` (PulseAudio or PipeWire's pulse server), run inside the agent:
 * a TS port of the macOS helper's Swift `Ducker` semantics.
 */
import type { MediaState, ServiceStateInfo } from "../../sdk/index.ts";
import { errorMessage } from "../errors.ts";
import type { Logger } from "../log.ts";
import type { CommandRunner } from "./command.ts";

/** `pactl -f json` appeared in 16. */
export const MIN_PACTL_MAJOR = 16;
/** A channel BGB set that now differs by more than 2 % of full scale was changed by the user. */
export const USER_CHANGE_TOLERANCE = Math.round(0.02 * 65536);
export const FADE_STEPS = 8;
export const FADE_STEP_MS = 85;

const TARGET_APP = /^spotify$/i;

export interface SinkInput {
	index: number;
	/** For logs. */
	name: string;
	/** Raw per-channel volumes (65536 = 100 %), in channel-map order. */
	volumes: number[];
	properties: Record<string, string>;
}

function channelValue(entry: unknown): number | undefined {
	const value = (entry as { value?: unknown } | null)?.value;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parses `pactl -f json list sink-inputs`; streams with unreadable volumes are skipped. */
export function parseSinkInputs(json: string): SinkInput[] {
	const parsed: unknown = JSON.parse(json);
	if (!Array.isArray(parsed)) throw new Error("pactl: expected a JSON array of sink inputs");
	const inputs: SinkInput[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const raw = item as Record<string, unknown>;
		if (typeof raw.index !== "number") continue;
		const volume = typeof raw.volume === "object" && raw.volume !== null ? (raw.volume as Record<string, unknown>) : {};
		const channels =
			typeof raw.channel_map === "string" && raw.channel_map.length > 0 ? raw.channel_map.split(",") : Object.keys(volume);
		const volumes = channels.map((channel) => channelValue(volume[channel]));
		if (volumes.length === 0 || volumes.some((value) => value === undefined)) continue;
		const properties: Record<string, string> = {};
		if (typeof raw.properties === "object" && raw.properties !== null) {
			for (const [key, value] of Object.entries(raw.properties)) if (typeof value === "string") properties[key] = value;
		}
		inputs.push({
			index: raw.index,
			name: properties["application.name"] ?? properties["application.process.binary"] ?? `#${raw.index}`,
			volumes: volumes as number[],
			properties,
		});
	}
	return inputs;
}

/** Streams BGB lowers: Spotify, by process binary or application name. */
export function isDuckTarget(input: SinkInput): boolean {
	const binary = input.properties["application.process.binary"];
	const name = input.properties["application.name"];
	return (binary !== undefined && TARGET_APP.test(binary)) || (name !== undefined && TARGET_APP.test(name));
}

/** Per channel `round(original × level)`. */
export function duckedVolumes(original: readonly number[], level: number): number[] {
	return original.map((value) => Math.round(value * level));
}

/** One restore-fade step: 1/(steps left) of the way from what BGB last set back to the original. */
export function fadeStepVolumes(lastSet: readonly number[], original: readonly number[], stepsLeft: number): number[] {
	return original.map((target, channel) => {
		const from = lastSet[channel] ?? target;
		return stepsLeft <= 1 ? target : from + Math.round((target - from) / stepsLeft);
	});
}

/** True when any channel moved more than the tolerance away from what BGB set (or the channel count changed). */
export function userChanged(current: readonly number[], lastSet: readonly number[]): boolean {
	return (
		current.length !== lastSet.length ||
		current.some((value, channel) => Math.abs(value - (lastSet[channel] ?? value)) > USER_CHANGE_TOLERANCE)
	);
}

/** Major version from `pactl --version` ("pactl 16.1"), or `null`. */
export function parsePactlMajor(output: string): number | null {
	const match = /^pactl\s+(\d+)/m.exec(output);
	return match?.[1] ? Number(match[1]) : null;
}

interface DuckRecord {
	index: number;
	name: string;
	original: number[];
	lastSet: number[];
}

export interface LinuxDuckerOptions {
	run: CommandRunner;
	log: Logger;
	sleep?: (ms: number) => Promise<void>;
	fadeStepMs?: number;
}

/**
 * Converges Spotify's sink-input volumes to the wanted duck level. Requests are serialized: each one
 * queues a convergence pass, so duck/release stay ordered and a duck arriving mid-fade cuts the fade
 * short and re-levels from the recorded originals.
 */
export class LinuxDucker {
	private readonly run: CommandRunner;
	private readonly log: Logger;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly fadeStepMs: number;
	/** Wanted level; `null` = released. */
	private target: number | null = null;
	/** Level the streams were converged to; `null` = not ducked (or fading back). */
	private applied: number | null = null;
	private records: DuckRecord[] = [];
	private fading = false;
	private fadeStepsDone = 0;
	private immediate = false;
	private queue: Promise<void> = Promise.resolve();

	constructor(opts: LinuxDuckerOptions) {
		this.run = opts.run;
		this.log = opts.log;
		this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
		this.fadeStepMs = opts.fadeStepMs ?? FADE_STEP_MS;
	}

	/** `ready`, or `unsupported` without `pactl` ≥ 16. */
	async probe(): Promise<ServiceStateInfo<MediaState>> {
		const result = await this.run(["pactl", "--version"], { timeoutMs: 5_000 });
		if (result.code !== 0) return { state: "unsupported", detail: "pactl (PulseAudio or PipeWire) was not found" };
		const major = parsePactlMajor(result.stdout);
		if (major === null || major < MIN_PACTL_MAJOR) {
			return { state: "unsupported", detail: `pactl ${major ?? "?"} is too old; ducking needs ${MIN_PACTL_MAJOR} or newer` };
		}
		return { state: "ready" };
	}

	/** Wants `level` (0–1; `null` or ≥ 1 releases with a fade). Resolves once that request has converged. */
	request(level: number | null): Promise<void> {
		this.target = level === null || level >= 1 ? null : Math.max(0, level);
		return this.enqueue();
	}

	/** Restores every lowered stream at once, without a fade (agent shutdown). */
	restoreNow(): Promise<void> {
		this.target = null;
		this.immediate = true;
		return this.enqueue();
	}

	private enqueue(): Promise<void> {
		this.queue = this.queue.then(() => this.converge()).catch((error) => this.log.error(`duck: ${errorMessage(error)}`));
		return this.queue;
	}

	private async converge(): Promise<void> {
		for (;;) {
			const wanted = this.target;
			if (wanted !== null) {
				if (wanted === this.applied) return;
				if (this.applied === null && this.records.length === 0) await this.duck(wanted);
				else await this.relevel(wanted);
				this.fading = false;
				this.applied = wanted;
				continue;
			}
			if (this.applied !== null) {
				this.applied = null;
				this.fadeStepsDone = 0;
				this.fading = this.records.length > 0;
			}
			if (!this.fading) {
				this.immediate = false;
				return;
			}
			await this.fadeStep();
			if (this.fading && !this.immediate) await this.sleep(this.fadeStepMs);
		}
	}

	private async list(): Promise<SinkInput[]> {
		const result = await this.run(["pactl", "-f", "json", "list", "sink-inputs"], { timeoutMs: 5_000 });
		if (result.code !== 0) throw new Error(`pactl list sink-inputs failed: ${result.stderr.trim() || result.code}`);
		return parseSinkInputs(result.stdout);
	}

	private async set(index: number, volumes: readonly number[]): Promise<boolean> {
		const result = await this.run(["pactl", "set-sink-input-volume", String(index), ...volumes.map(String)], {
			timeoutMs: 5_000,
		});
		if (result.code !== 0) this.log.warn(`duck: setting stream #${index} failed: ${result.stderr.trim() || result.code}`);
		return result.code === 0;
	}

	private async duck(level: number): Promise<void> {
		for (const input of (await this.list()).filter(isDuckTarget)) {
			const values = duckedVolumes(input.volumes, level);
			if (!(await this.set(input.index, values))) continue;
			this.records.push({ index: input.index, name: input.name, original: input.volumes, lastSet: values });
			this.log.info(`duck: ${input.name} volume ${input.volumes.join(" ")} -> ${values.join(" ")} (level ${level})`);
		}
		if (this.records.length === 0) this.log.info(`duck: no stream lowered (level ${level})`);
	}

	private async relevel(level: number): Promise<void> {
		const current = await this.list();
		const kept: DuckRecord[] = [];
		for (const record of this.records) {
			if (await this.setIfUnchanged(record, duckedVolumes(record.original, level), current)) kept.push(record);
		}
		this.records = kept;
	}

	private async fadeStep(): Promise<void> {
		const stepsLeft = this.immediate ? 1 : FADE_STEPS - this.fadeStepsDone;
		this.fadeStepsDone++;
		const current = await this.list();
		const kept: DuckRecord[] = [];
		for (const record of this.records) {
			const values = fadeStepVolumes(record.lastSet, record.original, stepsLeft);
			const unchanged = values.every((value, channel) => value === record.lastSet[channel]);
			if (unchanged && stepsLeft > 1) {
				kept.push(record);
				continue;
			}
			if ((await this.setIfUnchanged(record, values, current)) && stepsLeft > 1) kept.push(record);
		}
		this.records = kept;
		if (this.records.length === 0) this.fading = false;
	}

	/** Sets `values` while the stream still has what BGB set last; false = stop managing it. */
	private async setIfUnchanged(record: DuckRecord, values: number[], current: SinkInput[]): Promise<boolean> {
		const now = current.find((input) => input.index === record.index);
		if (!now) {
			this.log.info(`duck: ${record.name} stream ended; nothing to set`);
			return false;
		}
		if (userChanged(now.volumes, record.lastSet)) {
			this.log.info(
				`duck: ${record.name} volume is ${now.volumes.join(" ")}, not ${record.lastSet.join(" ")}: the user changed it; left alone`,
			);
			return false;
		}
		if (await this.set(record.index, values)) record.lastSet = values;
		return true;
	}
}

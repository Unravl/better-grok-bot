import { expect, test } from "bun:test";
import { nullLogger } from "../log.ts";
import type { CommandRunner } from "./command.ts";
import {
	LinuxDucker,
	USER_CHANGE_TOLERANCE,
	duckedVolumes,
	fadeStepVolumes,
	isDuckTarget,
	parsePactlMajor,
	parseSinkInputs,
	userChanged,
} from "./media-linux.ts";

const SAMPLE = JSON.stringify([
	{
		index: 42,
		sink: 0,
		channel_map: "front-left,front-right",
		volume: {
			"front-left": { value: 52428, value_percent: "80%", db: "-5.81 dB" },
			"front-right": { value: 26214, value_percent: "40%", db: "-23.88 dB" },
		},
		properties: { "application.name": "Spotify", "application.process.binary": "spotify" },
	},
	{
		index: 43,
		channel_map: "mono",
		volume: { mono: { value: 65536 } },
		properties: { "application.name": "Firefox", "application.process.binary": "firefox" },
	},
	{ index: 44, volume: { "front-left": { value: "bad" } }, properties: {} },
]);

test("parseSinkInputs reads per-channel raw volumes in channel-map order", () => {
	const inputs = parseSinkInputs(SAMPLE);
	expect(inputs.map((input) => [input.index, input.name, input.volumes])).toEqual([
		[42, "Spotify", [52428, 26214]],
		[43, "Firefox", [65536]],
	]);
	expect(inputs.filter(isDuckTarget).map((input) => input.index)).toEqual([42]);
	expect(isDuckTarget({ index: 1, name: "x", volumes: [1], properties: { "application.process.binary": "SPOTIFY" } })).toBe(true);
	expect(() => parseSinkInputs("{}")).toThrow("expected a JSON array");
});

test("duck math, fade steps and the user-change tolerance", () => {
	expect(duckedVolumes([52428, 26214], 0.5)).toEqual([26214, 13107]);
	expect(fadeStepVolumes([26214, 13107], [52428, 26214], 8)).toEqual([26214 + 3277, 13107 + 1638]);
	expect(fadeStepVolumes([26214, 13107], [52428, 26214], 1)).toEqual([52428, 26214]);
	expect(USER_CHANGE_TOLERANCE).toBe(1311);
	expect(userChanged([26214 + 1311, 13107], [26214, 13107])).toBe(false);
	expect(userChanged([26214 + 1312, 13107], [26214, 13107])).toBe(true);
	expect(userChanged([26214], [26214, 13107])).toBe(true);
	expect(parsePactlMajor("pactl 16.1\nCompiled with libpulse 16.1.0\n")).toBe(16);
	expect(parsePactlMajor("nothing")).toBeNull();
});

interface FakeStream {
	index: number;
	name: string;
	volumes: number[];
}

function fakePactl(streams: FakeStream[], version = "pactl 16.1") {
	const sets: { index: number; volumes: number[] }[] = [];
	const run: CommandRunner = async (argv) => {
		const args = argv.slice(1).join(" ");
		if (args === "--version") return { code: 0, stdout: `${version}\n`, stderr: "" };
		if (args === "-f json list sink-inputs") {
			const json = streams.map((stream) => ({
				index: stream.index,
				channel_map: stream.volumes.map((_, i) => `ch${i}`).join(","),
				volume: Object.fromEntries(stream.volumes.map((value, i) => [`ch${i}`, { value }])),
				properties: { "application.name": stream.name },
			}));
			return { code: 0, stdout: JSON.stringify(json), stderr: "" };
		}
		if (argv[1] === "set-sink-input-volume") {
			const stream = streams.find((candidate) => candidate.index === Number(argv[2]));
			if (!stream) return { code: 1, stdout: "", stderr: "No such entity" };
			stream.volumes = argv.slice(3).map(Number);
			sets.push({ index: stream.index, volumes: [...stream.volumes] });
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 127, stdout: "", stderr: `unexpected ${args}` };
	};
	return { run, sets };
}

const noSleep = async (): Promise<void> => {};

test("probe needs pactl 16 or newer", async () => {
	expect(await new LinuxDucker({ run: fakePactl([]).run, log: nullLogger }).probe()).toEqual({ state: "ready" });
	expect((await new LinuxDucker({ run: fakePactl([], "pactl 15.0").run, log: nullLogger }).probe()).state).toBe("unsupported");
	const missing: CommandRunner = async () => ({ code: 127, stdout: "", stderr: "ENOENT" });
	expect(await new LinuxDucker({ run: missing, log: nullLogger }).probe()).toEqual({
		state: "unsupported",
		detail: "pactl (PulseAudio or PipeWire) was not found",
	});
});

test("ducks Spotify per channel, re-levels from originals and fades back in 8 steps", async () => {
	const spotify = { index: 7, name: "Spotify", volumes: [52428, 26214] };
	const other = { index: 8, name: "Firefox", volumes: [65536, 65536] };
	const pactl = fakePactl([spotify, other]);
	const ducker = new LinuxDucker({ run: pactl.run, log: nullLogger, sleep: noSleep });

	await ducker.request(0.5);
	expect(spotify.volumes).toEqual([26214, 13107]);
	expect(other.volumes).toEqual([65536, 65536]);

	await ducker.request(0.25);
	expect(spotify.volumes).toEqual([13107, 6554]);

	pactl.sets.length = 0;
	await ducker.request(null);
	expect(spotify.volumes).toEqual([52428, 26214]);
	expect(pactl.sets).toHaveLength(8);
	expect(pactl.sets.every((set) => set.index === 7)).toBe(true);
	// Monotonic fade up.
	for (let i = 1; i < pactl.sets.length; i++) {
		expect(pactl.sets[i]?.volumes[0] ?? 0).toBeGreaterThanOrEqual(pactl.sets[i - 1]?.volumes[0] ?? 0);
	}
});

test("a manual volume change mid-duck stops managing that stream", async () => {
	const spotify = { index: 7, name: "Spotify", volumes: [52428, 26214] };
	const pactl = fakePactl([spotify]);
	const ducker = new LinuxDucker({ run: pactl.run, log: nullLogger, sleep: noSleep });
	await ducker.request(0.5);
	spotify.volumes = [40000, 40000];
	pactl.sets.length = 0;
	await ducker.request(0.3);
	await ducker.request(null);
	expect(spotify.volumes).toEqual([40000, 40000]);
	expect(pactl.sets).toEqual([]);
});

test("restoreNow restores at once without a fade", async () => {
	const spotify = { index: 7, name: "Spotify", volumes: [65536, 65536] };
	const pactl = fakePactl([spotify]);
	const ducker = new LinuxDucker({ run: pactl.run, log: nullLogger, sleep: noSleep });
	await ducker.request(0.5);
	pactl.sets.length = 0;
	await ducker.restoreNow();
	expect(spotify.volumes).toEqual([65536, 65536]);
	expect(pactl.sets).toHaveLength(1);
});

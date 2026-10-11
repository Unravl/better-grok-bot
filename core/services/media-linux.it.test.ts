/**
 * Integration test against a real PulseAudio/PipeWire server (CI job `linux-it`, `BGB_PULSE_IT=1`):
 * a `pacat` stream named Spotify is ducked and restored through `pactl`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { nullLogger } from "../log.ts";
import { runCommand } from "./command.ts";
import { LinuxDucker, parseSinkInputs } from "./media-linux.ts";

const enabled = process.env.BGB_PULSE_IT === "1";
let player: Bun.Subprocess | undefined;
let index = -1;

async function volumes(): Promise<number[]> {
	const result = await runCommand(["pactl", "-f", "json", "list", "sink-inputs"]);
	return parseSinkInputs(result.stdout).find((input) => input.index === index)?.volumes ?? [];
}

async function setVolumes(values: number[]): Promise<void> {
	const result = await runCommand(["pactl", "set-sink-input-volume", String(index), ...values.map(String)]);
	if (result.code !== 0) throw new Error(result.stderr);
}

function near(actual: number[], expected: number[]): void {
	expect(actual).toHaveLength(expected.length);
	actual.forEach((value, channel) => expect(Math.abs(value - (expected[channel] ?? 0))).toBeLessThanOrEqual(1));
}

beforeAll(async () => {
	if (!enabled) return;
	player = Bun.spawn(["sh", "-c", "exec pacat --property=application.name=Spotify < /dev/zero"], { stdout: "ignore", stderr: "inherit" });
	const deadline = Date.now() + 10_000;
	while (index < 0 && Date.now() < deadline) {
		const result = await runCommand(["pactl", "-f", "json", "list", "sink-inputs"]);
		index = parseSinkInputs(result.stdout).find((input) => input.properties["application.name"] === "Spotify")?.index ?? -1;
		// Real delay: the stream appears on the real PulseAudio server asynchronously; nothing to await.
		if (index < 0) await Bun.sleep(200);
	}
	if (index < 0) throw new Error("pacat stream did not appear");
});

afterAll(() => {
	player?.kill();
});

test.skipIf(!enabled)("ducks a Spotify stream to the level and restores it after the fade", async () => {
	await setVolumes([52428, 26214]);
	const ducker = new LinuxDucker({ run: runCommand, log: nullLogger });
	expect((await ducker.probe()).state).toBe("ready");
	await ducker.request(0.5);
	near(await volumes(), [26214, 13107]);
	await ducker.request(null);
	near(await volumes(), [52428, 26214]);
});

test.skipIf(!enabled)("a manual volume change mid-duck stops BGB managing the stream", async () => {
	await setVolumes([52428, 26214]);
	const ducker = new LinuxDucker({ run: runCommand, log: nullLogger });
	await ducker.request(0.5);
	await setVolumes([39321, 39321]);
	await ducker.request(null);
	near(await volumes(), [39321, 39321]);
});

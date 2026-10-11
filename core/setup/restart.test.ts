import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createContext } from "../context.ts";
import { nullLogger } from "../log.ts";
import { rendererUrl } from "../paths.ts";
import type { AppInstall, PlatformAdapter } from "../platform/types.ts";
import { type RestartOptions, restartApp } from "./restart.ts";
import { type Call, type FakeHostOptions, fakeHost, recordingAdapter } from "./test-fakes.ts";

const APP: AppInstall = {
	kind: "mac-bundle",
	root: "/Applications/Grok Bot.app",
	executable: "/Applications/Grok Bot.app/Contents/MacOS/Grok Bot",
	asarPath: "/Applications/Grok Bot.app/Contents/Resources/app.asar",
	version: "0.68.1",
};
const OPTS: RestartOptions = { yes: false, force: false, interactive: false, args: [] };

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "bgb-restart-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function setup(adapter: Partial<PlatformAdapter>, hostOpts: FakeHostOptions = {}) {
	const calls: Call[] = [];
	const ctx = await createContext({ dataDir: path.join(root, "data"), platform: recordingAdapter(calls, adapter), log: nullLogger });
	const host = fakeHost(path.join(root, "home"), hostOpts);
	const names = (): string[] => calls.map((call) => call.name);
	return { ctx, host, calls, names };
}

/** `quitApp` answers: graceful attempts return `graceful`, forced ones return `forced`. */
function quitting(graceful: boolean, forced = true): Partial<PlatformAdapter> {
	return {
		findRunningApp: async () => ({ pid: 4242 }),
		quitApp: async (_pid, opts) => (opts.force ? forced : graceful),
	};
}

test("a Grok Bot that is not running is launched with the renderer URL and args", async () => {
	const { ctx, host, calls } = await setup({});
	expect(await restartApp(ctx, APP, { ...OPTS, args: ["--remote-debugging-port=9333"] }, host)).toBe("launched");
	const launch = calls.find((call) => call.name === "launchApp");
	expect(launch?.args).toEqual([APP, { VITE_DEV_SERVER_URL: rendererUrl(ctx.paths) }, ["--remote-debugging-port=9333"]]);
});

test("with yes, a running Grok Bot is quit gracefully and relaunched", async () => {
	const { ctx, host, calls, names } = await setup(quitting(true));
	expect(await restartApp(ctx, APP, { ...OPTS, yes: true }, host)).toBe("restarted");
	expect(names()).toEqual(["findRunningApp", "quitApp", "launchApp"]);
	expect(calls[1]?.args).toEqual([4242, { force: false }]);
	expect(calls[2]?.args[1]).toEqual({ VITE_DEV_SERVER_URL: rendererUrl(ctx.paths) });
	expect(host.questions).toEqual([]);
});

test("without yes, a non-interactive restart is skipped with a hint", async () => {
	const { ctx, host, names } = await setup(quitting(true));
	expect(await restartApp(ctx, APP, OPTS, host)).toBe("skipped");
	expect(names()).toEqual(["findRunningApp"]);
	expect(host.out).toEqual(["Restart Grok Bot to load Better Grok Bot."]);
});

test("interactive: the user is asked, and a no skips", async () => {
	const { ctx, host, names } = await setup(quitting(true), { interactive: true, answers: [false] });
	expect(await restartApp(ctx, APP, { ...OPTS, interactive: true }, host)).toBe("skipped");
	expect(host.questions).toEqual(["Restart Grok Bot now to load Better Grok Bot?"]);
	expect(names()).toEqual(["findRunningApp"]);
});

test("a Grok Bot that ignores the graceful quit is never forced without force or consent", async () => {
	const { ctx, host, calls } = await setup(quitting(false));
	expect(await restartApp(ctx, APP, { ...OPTS, yes: true }, host)).toBe("did-not-quit");
	expect(calls.filter((call) => call.name === "quitApp").map((call) => call.args[1])).toEqual([{ force: false }]);
	expect(calls.some((call) => call.name === "launchApp")).toBe(false);
	expect(host.out).toEqual(["Grok Bot did not quit; restart it yourself."]);
});

test("force quits after a failed graceful quit, then relaunches", async () => {
	const { ctx, host, calls } = await setup(quitting(false));
	expect(await restartApp(ctx, APP, { ...OPTS, yes: true, force: true }, host)).toBe("restarted");
	expect(calls.filter((call) => call.name === "quitApp").map((call) => call.args[1])).toEqual([
		{ force: false },
		{ force: true },
	]);
	expect(calls.at(-1)?.name).toBe("launchApp");
});

test("interactive consent to force quit", async () => {
	const { ctx, host, names } = await setup(quitting(false), { interactive: true, answers: [true, true] });
	expect(await restartApp(ctx, APP, { ...OPTS, interactive: true }, host)).toBe("restarted");
	expect(host.questions).toEqual(["Restart Grok Bot now to load Better Grok Bot?", "Grok Bot did not quit. Force quit?"]);
	expect(names()).toEqual(["findRunningApp", "quitApp", "quitApp", "launchApp"]);
});

test("a bare app.asar has nothing to restart", async () => {
	const { ctx, host, names } = await setup(quitting(true));
	const custom: AppInstall = { kind: "custom", root: "/tmp", executable: "", asarPath: "/tmp/app.asar", version: "0.68.1" };
	expect(await restartApp(ctx, custom, { ...OPTS, yes: true }, host)).toBe("skipped");
	expect(names()).toEqual([]);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Platform } from "../../sdk/index.ts";
import { mutateConfig, readConfig } from "../config.ts";
import { type CoreContext, createContext } from "../context.ts";
import { nullLogger } from "../log.ts";
import { mutateState, readState } from "../state.ts";
import { migrateGrokMods, needsGrokModsMigration, restoreGrokMods } from "./migrate-grok-mods.ts";
import { type FakeHost, fakeHost, recordingAdapter } from "./test-fakes.ts";

const GROK_MODS_URL = "file:///Users/me/Library/Application%20Support/GrokMods/current/renderer/index.html";
const LABELS = ["local.grok-mods.hook", "local.grok-mods.push-to-talk", "local.grok-mods.startup.login"];

let root: string;
let home: string;
let ctx: CoreContext;
let host: FakeHost;

async function write(file: string, text: string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, text);
}

async function contextFor(id: Platform): Promise<CoreContext> {
	return createContext({ dataDir: path.join(root, `data-${id}`), platform: recordingAdapter([], { id }), log: nullLogger });
}

const launchAgents = (): string => path.join(home, "Library", "LaunchAgents");
const grokModsData = (): string => path.join(home, "Library", "Application Support", "GrokMods");
const launcher = (): string => path.join(home, "Applications", "Grok Bot Modded.app");
const pttHelper = (): string => path.join(grokModsData(), "helpers", "Grok Mods Push to Talk.app");

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "bgb-migrate-"));
	home = path.join(root, "home");
	ctx = await contextFor("darwin");
	host = fakeHost(home, {
		exec: (argv) =>
			argv.join(" ") === "launchctl getenv VITE_DEV_SERVER_URL" ? { code: 0, stdout: `${GROK_MODS_URL}\n`, stderr: "" } : undefined,
	});
	for (const label of LABELS) await write(path.join(launchAgents(), `${label}.plist`), `<plist>${label}</plist>`);
	await write(path.join(launchAgents(), "com.example.other.plist"), "<plist/>");
	await write(path.join(grokModsData(), "config.json"), JSON.stringify({ disabled: ["voice-keepalive"] }));
	await mkdir(path.join(grokModsData(), "mods", "my-mod"), { recursive: true });
	await write(path.join(pttHelper(), "Contents", "Info.plist"), "<plist>ptt</plist>");
	await write(path.join(launcher(), "Contents", "Info.plist"), "<string>local.grok-mods.launcher</string>");
	await mutateConfig(ctx.paths, (config) => {
		config.disabledPlugins = ["output-device"];
	});
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

test("needsGrokModsMigration: macOS with grok-mods leftovers that were not migrated yet", async () => {
	expect(await needsGrokModsMigration(ctx, host)).toBe(true);
	expect(await needsGrokModsMigration(await contextFor("linux"), host)).toBe(false);
	expect(await needsGrokModsMigration(ctx, fakeHost(path.join(root, "empty-home")))).toBe(false);
	await mutateState(ctx.paths, (state) => {
		state.migratedGrokMods = true;
	});
	expect(await needsGrokModsMigration(ctx, host)).toBe(false);
});

test("migrateGrokMods moves grok-mods out of the way and restoreGrokMods puts it back", async () => {
	await migrateGrokMods(ctx, host);

	const migrated = path.join(ctx.paths.migrated, "grok-mods");
	for (const label of LABELS) {
		expect(existsSync(path.join(launchAgents(), `${label}.plist`))).toBe(false);
		expect(await readFile(path.join(migrated, "LaunchAgents", `${label}.plist`), "utf8")).toBe(`<plist>${label}</plist>`);
		expect(host.commands).toContainEqual(["launchctl", "bootout", `gui/501/${label}`]);
	}
	expect(existsSync(path.join(launchAgents(), "com.example.other.plist"))).toBe(true);
	expect(await readFile(path.join(migrated, "env.txt"), "utf8")).toBe(GROK_MODS_URL);
	expect(host.commands).toContainEqual(["launchctl", "unsetenv", "VITE_DEV_SERVER_URL"]);
	expect(existsSync(launcher())).toBe(false);
	expect(existsSync(path.join(migrated, "Grok Bot Modded.app", "Contents", "Info.plist"))).toBe(true);
	expect(existsSync(pttHelper())).toBe(false);
	expect(existsSync(path.join(migrated, "Grok Mods Push to Talk.app", "Contents", "Info.plist"))).toBe(true);
	expect(existsSync(path.join(grokModsData(), "config.json"))).toBe(true);
	const config = await readConfig(ctx.paths);
	expect(config.openAtLogin).toBe(true);
	expect(config.disabledPlugins).toEqual(["output-device", "voice-keepalive"]);
	expect((await readState(ctx.paths)).migratedGrokMods).toBe(true);
	expect(host.out.some((line) => line.includes("Not migrated") && line.includes("my-mod"))).toBe(true);

	host.commands.length = 0;
	await restoreGrokMods(ctx, host);

	for (const label of LABELS) {
		const plist = path.join(launchAgents(), `${label}.plist`);
		expect(await readFile(plist, "utf8")).toBe(`<plist>${label}</plist>`);
		expect(host.commands).toContainEqual(["launchctl", "bootstrap", "gui/501", plist]);
	}
	expect(host.commands).toContainEqual(["launchctl", "setenv", "VITE_DEV_SERVER_URL", GROK_MODS_URL]);
	expect(existsSync(path.join(launcher(), "Contents", "Info.plist"))).toBe(true);
	expect(existsSync(path.join(pttHelper(), "Contents", "Info.plist"))).toBe(true);
	const restored = await readConfig(ctx.paths);
	expect(restored.openAtLogin).toBe(false);
	expect(restored.disabledPlugins).toEqual(["output-device"]);
	expect((await readState(ctx.paths)).migratedGrokMods).toBe(false);
	expect(existsSync(migrated)).toBe(false);
});

test("a foreign VITE_DEV_SERVER_URL and an unrelated ~/Applications app are left alone", async () => {
	await write(path.join(launcher(), "Contents", "Info.plist"), "<string>com.someone.else</string>");
	const foreignHost = fakeHost(home, {
		exec: (argv) =>
			argv[1] === "getenv" ? { code: 0, stdout: "http://localhost:5173/\n", stderr: "" } : undefined,
	});

	await migrateGrokMods(ctx, foreignHost);

	expect(foreignHost.commands.some((argv) => argv[1] === "unsetenv")).toBe(false);
	expect(existsSync(path.join(launcher(), "Contents", "Info.plist"))).toBe(true);

	await restoreGrokMods(ctx, foreignHost);
	expect(foreignHost.commands.some((argv) => argv[1] === "setenv")).toBe(false);
});

test("a failing step restores what the migration already changed", async () => {
	const failingHost = fakeHost(home, {
		exec: (argv) => {
			if (argv[1] === "getenv") return { code: 0, stdout: GROK_MODS_URL, stderr: "" };
			if (argv[1] === "unsetenv") return { code: 1, stdout: "", stderr: "denied" };
			return undefined;
		},
	});

	await expect(migrateGrokMods(ctx, failingHost)).rejects.toThrow("launchctl unsetenv VITE_DEV_SERVER_URL failed: denied");

	for (const label of LABELS) expect(existsSync(path.join(launchAgents(), `${label}.plist`))).toBe(true);
	const config = await readConfig(ctx.paths);
	expect(config.openAtLogin).toBe(false);
	expect((await readState(ctx.paths)).migratedGrokMods).toBe(false);
});

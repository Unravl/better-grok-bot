import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { main } from "./cli.ts";
import { captureIo, fakePlatform } from "./commands/testing.ts";
import { mutateConfig, readConfig } from "./config.ts";
import { nullLogger } from "./log.ts";
import { dataPaths } from "./paths.ts";
import { BGB_VERSION } from "./version.ts";

let parent: string;
let dataDir: string;
const savedDataDir = process.env.BGB_DATA_DIR;

beforeEach(async () => {
	parent = await mkdtemp(path.join(tmpdir(), "bgb-cli-"));
	dataDir = path.join(parent, "data");
});

afterEach(async () => {
	if (savedDataDir === undefined) delete process.env.BGB_DATA_DIR;
	else process.env.BGB_DATA_DIR = savedDataDir;
	await rm(parent, { recursive: true, force: true });
});

async function run(...argv: string[]) {
	const io = captureIo();
	const code = await main(argv, { io, platform: fakePlatform(), log: nullLogger });
	return { code, stdout: io.stdout.join("\n"), stderr: io.stderr.join("\n") };
}

test("--version prints exactly the version and never creates DATA", async () => {
	const result = await run("--data-dir", dataDir, "--version");
	expect(result).toEqual({ code: 0, stdout: BGB_VERSION, stderr: "" });
	expect(existsSync(dataDir)).toBe(false);
});

test("help and a bare bgb print usage with exit 0", async () => {
	for (const argv of [["help"], [], ["--help"]]) {
		const result = await run(...argv);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage: bgb [--data-dir <path>] <command>");
	}
});

test("usage errors exit 2 with a bgb: message on stderr", async () => {
	const cases: [string[], string][] = [
		[["frobnicate"], 'unknown command "frobnicate"'],
		[["--verbose", "status"], "unknown option --verbose"],
		[["--data-dir"], "--data-dir needs a path"],
		[["--data-dir", dataDir, "plugins", "enable"], "missing argument"],
		[["--data-dir", dataDir, "plugins", "frob"], 'unknown subcommand "frob"'],
		[["--data-dir", dataDir, "config", "set", "bridgePort"], "missing argument"],
		[["--data-dir", dataDir, "config", "get", "bridgeToken"], 'unknown config key "bridgeToken"'],
		[["--data-dir", dataDir, "build", "--app"], "--app needs a value"],
		[["--data-dir", dataDir, "status", "--bogus"], "unknown option --bogus"],
		[["--data-dir", dataDir, "stop", "extra"], 'unexpected argument "extra"'],
		[["check"], "--asar <path> is required"],
		[["--data-dir", dataDir, "update-watchdog", "--expect", "1.0.0"], "--timeout"],
	];
	for (const [argv, message] of cases) {
		const result = await run(...argv);
		expect({ argv, code: result.code }).toEqual({ argv, code: 2 });
		expect(result.stderr).toStartWith("bgb: ");
		expect(result.stderr).toContain(message);
	}
});

test("global --data-dir selects DATA and is exported as BGB_DATA_DIR", async () => {
	expect((await run("--data-dir", dataDir, "config", "set", "autoUpdate", "false")).code).toBe(0);
	expect(process.env.BGB_DATA_DIR).toBe(path.resolve(dataDir));
	expect((await readConfig(dataPaths(dataDir))).autoUpdate).toBe(false);
	const got = await run(`--data-dir=${dataDir}`, "config", "get", "autoUpdate");
	expect(got).toEqual({ code: 0, stdout: "false", stderr: "" });
});

test("config set bridgePort accepts unprivileged ports only", async () => {
	for (const bad of ["80", "abc", "70000", "4000.5", "-1"]) {
		const result = await run("--data-dir", dataDir, "config", "set", "bridgePort", bad);
		expect({ bad, code: result.code }).toEqual({ bad, code: 2 });
	}
	expect((await readConfig(dataPaths(dataDir))).bridgePort).toBe(39320);
	const ok = await run("--data-dir", dataDir, "config", "set", "bridgePort", "40000");
	expect(ok.code).toBe(0);
	expect((await readConfig(dataPaths(dataDir))).bridgePort).toBe(40000);
});

test("config set openAtLogin needs true or false; appPath must exist or be null", async () => {
	expect((await run("--data-dir", dataDir, "config", "set", "openAtLogin", "yes")).code).toBe(2);
	expect((await run("--data-dir", dataDir, "config", "set", "openAtLogin", "true")).code).toBe(0);
	expect((await run("--data-dir", dataDir, "config", "set", "appPath", path.join(parent, "missing"))).code).toBe(1);
	expect((await run("--data-dir", dataDir, "config", "set", "appPath", parent)).code).toBe(0);
	expect((await readConfig(dataPaths(dataDir))).appPath).toBe(parent);
	expect((await run("--data-dir", dataDir, "config", "set", "appPath", "null")).code).toBe(0);
	const config = await readConfig(dataPaths(dataDir));
	expect(config.appPath).toBeNull();
	expect(config.openAtLogin).toBe(true);
});

test("plugins disable of a core plugin fails with exit 1 and leaves config untouched", async () => {
	await mutateConfig(dataPaths(dataDir), () => {});
	for (const id of ["bgb-react", "bgb-settings", "bgb"]) {
		const result = await run("--data-dir", dataDir, "plugins", "disable", id);
		expect(result.code).toBe(1);
		expect(result.stderr).toBe(`bgb: ${id} is a core plugin; it is always enabled`);
	}
	expect((await readConfig(dataPaths(dataDir))).disabledPlugins).toEqual([]);
});

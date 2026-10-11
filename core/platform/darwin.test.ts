import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dataPaths, rendererUrl } from "../paths.ts";
import { makeFixtureAsar } from "../test/fixtures.ts";
import type { CommandResult, CommandRunner } from "./common.ts";
import {
	AGENT_LABEL,
	LOGIN_LABEL,
	agentPlist,
	createDarwinAdapter,
	launchAgentPath,
	loginPlist,
	parsePsMainPid,
	plistXml,
} from "./darwin.ts";
import { type AppInstall, HookConflictError } from "./types.ts";

let tmp: string;
let calls: string[][];
let spawned: { argv: string[]; env: Record<string, string | undefined> }[];
let launchdEnv: string | null;

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

/** A fake `launchctl` with one GUI-domain variable; every other command succeeds silently. */
const run: CommandRunner = async (argv) => {
	calls.push(argv);
	if (argv[0] === "launchctl" && argv[1] === "getenv") return launchdEnv === null ? { code: 1, stdout: "", stderr: "" } : ok(`${launchdEnv}\n`);
	if (argv[0] === "launchctl" && argv[1] === "setenv") launchdEnv = argv[3] ?? null;
	if (argv[0] === "launchctl" && argv[1] === "unsetenv") launchdEnv = null;
	return ok();
};

beforeEach(async () => {
	tmp = await realpath(await mkdtemp(path.join(tmpdir(), "bgb-darwin-")));
	calls = [];
	spawned = [];
	launchdEnv = null;
});
afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

function adapter(overrides: { run?: CommandRunner; appLocations?: string[] } = {}) {
	return createDarwinAdapter({
		run: overrides.run ?? run,
		spawn: (argv, opts) => spawned.push({ argv, env: opts.env }),
		env: { PATH: "/usr/bin" },
		home: path.join(tmp, "home"),
		uid: 501,
		appLocations: overrides.appLocations,
	});
}

const paths = dataPaths("/Users/u/Library/Application Support/BetterGrokBot");
const URL = rendererUrl(paths);
const APP: AppInstall = {
	kind: "mac-bundle",
	root: "/Applications/Grok Bot.app",
	executable: "/Applications/Grok Bot.app/Contents/MacOS/Grok Bot",
	asarPath: "/Applications/Grok Bot.app/Contents/Resources/app.asar",
	version: "0.68.1",
};

describe("hook (launchctl)", () => {
	test("installs when unset, reports active, removes only our value", async () => {
		const darwin = adapter();
		expect(await darwin.hookStatus(URL, APP)).toEqual({ state: "absent" });
		const record = await darwin.hookInstall(URL, APP, null);
		expect(record).toEqual({ kind: "launchctl", value: URL });
		expect(launchdEnv).toBe(URL);
		expect(await darwin.hookStatus(URL, APP)).toEqual({ state: "active" });
		expect(await darwin.hookRemove(record)).toBe("removed");
		expect(launchdEnv).toBeNull();
	});

	test("a foreign value is a conflict and is never overwritten", async () => {
		launchdEnv = "http://localhost:5173/";
		const darwin = adapter();
		expect(await darwin.hookStatus(URL, APP)).toEqual({ state: "conflict", value: "http://localhost:5173/" });
		await expect(darwin.hookInstall(URL, APP, null)).rejects.toBeInstanceOf(HookConflictError);
		expect(calls.some((argv) => argv[1] === "setenv")).toBe(false);
		expect(await darwin.hookRemove({ kind: "launchctl", value: URL })).toBe("not-owned");
		expect(launchdEnv).toBe("http://localhost:5173/");
	});

	test("a grok-mods value is replaced", async () => {
		launchdEnv = "file:///Users/u/Library/Application%20Support/GrokMods/current/renderer/index.html";
		const darwin = adapter();
		expect(await darwin.hookStatus(URL, APP)).toEqual({ state: "absent" });
		await darwin.hookInstall(URL, APP, null);
		expect(launchdEnv).toBe(URL);
	});
});

test("parsePsMainPid ignores helpers and other apps", () => {
	const exe = "/Applications/Grok Bot.app/Contents/MacOS/Grok Bot";
	const listing = [
		"  101 /sbin/launchd",
		`  202 /Applications/Grok Bot.app/Contents/Frameworks/Grok Bot Helper (Renderer).app/Contents/MacOS/Grok Bot Helper (Renderer) --type=renderer`,
		`  303 ${exe} --type=gpu-process`,
		`  404 ${exe} --remote-debugging-port=9333`,
		`  505 ${exe}`,
	].join("\n");
	expect(parsePsMainPid(listing, exe)).toBe(404);
	expect(parsePsMainPid("  1 /sbin/launchd\n", exe)).toBeUndefined();
});

describe("plists", () => {
	test("agent and login plists carry the data dir and the right arguments", () => {
		const bin = path.join(paths.bin, "bgb");
		const agent = agentPlist(bin, paths);
		expect(agent).toContain(`<key>Label</key>\n\t<string>${AGENT_LABEL}</string>`);
		expect(agent).toContain(`<key>ProgramArguments</key>\n\t<array>\n\t\t<string>${bin}</string>\n\t\t<string>agent</string>\n\t</array>`);
		expect(agent).toContain(`<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>BGB_DATA_DIR</key>\n\t\t<string>${paths.root}</string>\n\t</dict>`);
		expect(agent).toContain("<key>KeepAlive</key>\n\t<true/>");
		expect(agent).toContain("<key>ProcessType</key>\n\t<string>Background</string>");
		expect(agent).toContain(`<string>${path.join(paths.logs, "agent.stdout.log")}</string>`);
		const login = loginPlist(bin, paths);
		expect(login).toContain(`<string>${LOGIN_LABEL}</string>`);
		expect(login).toContain("<string>login</string>");
		expect(login).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(login).not.toContain("KeepAlive");
	});

	test("values are XML-escaped", () => {
		expect(plistXml({ A: "a & <b>" })).toContain("<string>a &amp; &lt;b&gt;</string>");
	});

	test.skipIf(process.platform !== "darwin")("plutil accepts the generated plist", async () => {
		const file = path.join(tmp, "agent.plist");
		await writeFile(file, agentPlist("/x/b&b/bgb", dataPaths("/x/b&b")));
		const proc = Bun.spawn(["plutil", "-convert", "json", "-o", "-", file], { stdout: "pipe" });
		const json = JSON.parse(await new Response(proc.stdout).text()) as Record<string, unknown>;
		expect(json.ProgramArguments).toEqual(["/x/b&b/bgb", "agent"]);
		expect(json.EnvironmentVariables).toEqual({ BGB_DATA_DIR: "/x/b&b" });
		expect(json.KeepAlive).toBe(true);
	});
});

describe("autostart and agent", () => {
	test("autostartInstall writes both plists and loads only the agent job", async () => {
		const darwin = adapter();
		const data = dataPaths(path.join(tmp, "data"));
		await darwin.autostartInstall(path.join(data.bin, "bgb"), data);
		const home = path.join(tmp, "home");
		expect(await readFile(launchAgentPath(home, AGENT_LABEL), "utf8")).toBe(agentPlist(path.join(data.bin, "bgb"), data));
		expect(await readFile(launchAgentPath(home, LOGIN_LABEL), "utf8")).toBe(loginPlist(path.join(data.bin, "bgb"), data));
		expect(calls).toEqual([
			["launchctl", "bootout", `gui/501/${AGENT_LABEL}`],
			["launchctl", "bootstrap", "gui/501", launchAgentPath(home, AGENT_LABEL)],
		]);
		await darwin.autostartRemove();
		expect(await Bun.file(launchAgentPath(home, AGENT_LABEL)).exists()).toBe(false);
		expect(await Bun.file(launchAgentPath(home, LOGIN_LABEL)).exists()).toBe(false);
		expect(calls).toContainEqual(["launchctl", "bootout", `gui/501/${LOGIN_LABEL}`]);
	});

	test("startAgent spawns detached with BGB_DATA_DIR without a plist, kickstarts with one", async () => {
		const darwin = adapter();
		const data = dataPaths(path.join(tmp, "data"));
		await darwin.startAgent("/bin/bgb", data);
		expect(spawned).toEqual([{ argv: ["/bin/bgb", "agent"], env: { PATH: "/usr/bin", BGB_DATA_DIR: data.root } }]);
		expect(calls).toEqual([]);
		const plist = launchAgentPath(path.join(tmp, "home"), AGENT_LABEL);
		await mkdir(path.dirname(plist), { recursive: true });
		await writeFile(plist, agentPlist("/bin/bgb", data));
		await darwin.startAgent("/bin/bgb", data);
		expect(spawned.length).toBe(1);
		expect(calls).toEqual([
			["launchctl", "bootstrap", "gui/501", plist],
			["launchctl", "kickstart", "-k", `gui/501/${AGENT_LABEL}`],
		]);
	});
});

test("locateApp reads an explicit bundle", async () => {
	const bundle = path.join(tmp, "Grok Bot.app");
	const asarPath = path.join(bundle, "Contents", "Resources", "app.asar");
	await makeFixtureAsar(path.dirname(asarPath), { version: "0.68.1", renderer: { "index.html": "" }, asarPath });
	const plistJson = JSON.stringify({ CFBundleIdentifier: "com.anysphere.sand", CFBundleExecutable: "Grok Bot" });
	const darwin = adapter({
		run: async (argv) => (argv[0] === "plutil" && argv[5] === path.join(bundle, "Contents", "Info.plist") ? ok(plistJson) : ok()),
	});
	expect(await darwin.locateApp(bundle)).toEqual({
		kind: "mac-bundle",
		root: bundle,
		executable: path.join(bundle, "Contents", "MacOS", "Grok Bot"),
		asarPath,
		version: "0.68.1",
	});
	const wrongId = adapter({ run: async () => ok(JSON.stringify({ CFBundleIdentifier: "com.other", CFBundleExecutable: "x" })) });
	await expect(wrongId.locateApp(bundle)).rejects.toThrow("expected com.anysphere.sand");
	await expect(darwin.locateApp(path.join(tmp, "missing.app"))).rejects.toThrow("no such app bundle");
});

test("launchApp passes the env and app args to open", async () => {
	await adapter().launchApp(APP, { VITE_DEV_SERVER_URL: URL }, ["--remote-debugging-port=9333"]);
	expect(calls).toEqual([
		["open", "-a", APP.root, "--env", `VITE_DEV_SERVER_URL=${URL}`, "--args", "--remote-debugging-port=9333"],
	]);
});

test("notify never throws", async () => {
	const darwin = adapter({
		run: async () => {
			throw new Error("boom");
		},
	});
	await expect(darwin.notify("t", "b")).resolves.toBeUndefined();
});

test("locateApp falls through unusable Spotlight results", async () => {
	const stale = path.join(tmp, "Stale.app");
	const other = path.join(tmp, "Other.app");
	const bundle = path.join(tmp, "Grok Bot.app");
	const asarPath = path.join(bundle, "Contents", "Resources", "app.asar");
	await mkdir(other);
	await makeFixtureAsar(path.dirname(asarPath), { version: "0.68.1", renderer: { "index.html": "" }, asarPath });
	const plist = (appPath: string) => path.join(appPath, "Contents", "Info.plist");
	const darwin = adapter({
		appLocations: [],
		run: async (argv) => {
			if (argv[0] === "mdfind") return ok(`${stale}\n${other}\n${bundle}\n`);
			if (argv[0] === "plutil" && argv[5] === plist(other)) return ok(JSON.stringify({ CFBundleIdentifier: "com.other", CFBundleExecutable: "x" }));
			if (argv[0] === "plutil" && argv[5] === plist(bundle)) return ok(JSON.stringify({ CFBundleIdentifier: "com.anysphere.sand", CFBundleExecutable: "Grok Bot" }));
			return ok();
		},
	});
	expect((await darwin.locateApp(null)).root).toBe(bundle);

	const none = adapter({
		appLocations: [],
		run: async (argv) => (argv[0] === "mdfind" ? ok(`${stale}\n${other}\n`) : ok(JSON.stringify({ CFBundleIdentifier: "com.other", CFBundleExecutable: "x" }))),
	});
	await expect(none.locateApp(null)).rejects.toThrow(/Spotlight results were unusable: .*Stale\.app.*; .*expected com\.anysphere\.sand/);
});

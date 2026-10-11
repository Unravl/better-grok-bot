import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { HELPER_CODES, type HelperToAgent, type Platform } from "../../sdk/index.ts";
import { type RecordingHost, recordingHost, waitFor } from "../agent/testing.ts";
import { nullLogger } from "../log.ts";
import { type DataPaths, dataPaths, ensureDataDir } from "../paths.ts";
import { sha256Hex } from "../update/download.ts";
import type { CommandRunner } from "./command.ts";
import { HELPER_APP_NAME, HELPER_LABEL, type HelperProcess, type HelperSpawner } from "./helper.ts";
import type { HelperManifest } from "./helper-manifest.ts";
import { Services, type ServicesOptions } from "./index.ts";
import { LinuxDucker } from "./media-linux.ts";

const SHA = "a".repeat(64);
const ALL_ASSETS: HelperManifest = {
	version: 3,
	tag: "helper-v3",
	assets: {
		"darwin-universal": { name: "bgb-helper-macos-universal.zip", sha256: SHA },
		"windows-x64": { name: "bgb-helper-windows-x64.exe", sha256: SHA },
		"linux-x64": { name: "bgb-helper-linux-x64", sha256: SHA },
	},
};

let root: string;
let paths: DataPaths;
let launchAgentsDir: string;
const services: Services[] = [];

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "bgb-services-"));
	paths = dataPaths(path.join(root, "data"));
	await ensureDataDir(paths);
	launchAgentsDir = path.join(root, "LaunchAgents");
});

afterEach(async () => {
	for (const service of services.splice(0)) await service.shutdown();
	await rm(root, { recursive: true, force: true });
});

const noCommands: CommandRunner = async (argv) => ({ code: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}` });

function create(platform: Platform, recorder: RecordingHost, opts: Partial<ServicesOptions> = {}): Services {
	const service = new Services({
		paths,
		log: nullLogger,
		platform,
		host: recorder.host,
		arch: "x64",
		env: {},
		manifest: ALL_ASSETS,
		run: noCommands,
		launchAgentsDir,
		uid: 501,
		...opts,
	});
	services.push(service);
	return service;
}

/** Marks the macOS helper as installed (plist + app executable). */
async function installMacHelper(): Promise<void> {
	await mkdir(launchAgentsDir, { recursive: true });
	await writeFile(path.join(launchAgentsDir, `${HELPER_LABEL}.plist`), "<plist/>");
	const macos = path.join(paths.helpers, HELPER_APP_NAME, "Contents", "MacOS");
	await mkdir(macos, { recursive: true });
	await writeFile(path.join(macos, "bgb-helper"), "");
	await writeFile(path.join(paths.helpers, "version.txt"), `${ALL_ASSETS.version}\n`);
}

type HelloFrame = Extract<HelperToAgent, { type: "hello" }>;

function hello(platform: Platform, keys: "granted" | "denied" | "unsupported" = "granted", media = true): HelloFrame {
	return { type: "hello", protocol: 4, platform, keys, codes: [...HELPER_CODES[platform]], media };
}

test("a helper disconnect while AltRight is down sends keys.key down:false to its watchers only", async () => {
	await installMacHelper();
	const recorder = recordingHost();
	const service = create("darwin", recorder);
	await service.start();
	expect(service.snapshot().keys).toEqual({ state: "starting" });

	expect(service.watchKeys(1, ["AltRight"])).toEqual({ unsupported: [] });
	expect(service.watchKeys(2, ["ControlLeft"])).toEqual({ unsupported: [] });
	service.helperOpened(100);
	service.helperMessage(100, hello("darwin"));
	expect(service.snapshot()).toEqual({ keys: { state: "ready" }, media: { state: "ready" } });
	expect(recorder.helperFrames).toEqual([
		{ connectionId: 100, message: { type: "watch", codes: ["AltRight", "ControlLeft"] } },
		{ connectionId: 100, message: { type: "duck", ducked: false, level: 1 } },
	]);

	service.helperMessage(100, { type: "key", code: "AltRight", down: true });
	service.helperMessage(100, { type: "key", code: "AltRight", down: true });
	service.helperMessage(100, { type: "chord", code: "AltRight" });
	expect(recorder.events).toEqual([
		{ connectionId: 1, event: "keys.key", data: { code: "AltRight", down: true } },
		{ connectionId: 1, event: "keys.chord", data: { code: "AltRight" } },
	]);

	recorder.events.length = 0;
	service.helperClosed(100);
	expect(recorder.events).toEqual([{ connectionId: 1, event: "keys.key", data: { code: "AltRight", down: false } }]);
	expect(service.snapshot().keys).toEqual({ state: "error", detail: "helper disconnected" });
	expect(recorder.broadcasts.at(-1)).toEqual({ event: "keys.state", data: { state: "error", detail: "helper disconnected" } });
});

test("a reconnecting helper receives the current watch union and duck level", async () => {
	await installMacHelper();
	const recorder = recordingHost();
	const service = create("darwin", recorder);
	await service.start();
	service.watchKeys(1, ["AltRight", "F5"]);
	service.watchKeys(2, ["AltRight", "MetaLeft"]);
	service.duck(1, 0.5);
	service.duck(2, 0.3);
	service.helperOpened(7);
	service.helperMessage(7, hello("darwin"));
	service.helperClosed(7);
	service.duck(2, 1);
	recorder.helperFrames.length = 0;

	service.helperOpened(8);
	service.helperMessage(8, hello("darwin"));
	expect(recorder.helperFrames).toEqual([
		{ connectionId: 8, message: { type: "watch", codes: ["AltRight", "F5", "MetaLeft"] } },
		{ connectionId: 8, message: { type: "duck", ducked: true, level: 0.5 } },
	]);

	// A renderer closing drops its watches and duck request.
	recorder.helperFrames.length = 0;
	service.rendererClosed(1);
	expect(recorder.helperFrames).toEqual([
		{ connectionId: 8, message: { type: "watch", codes: ["AltRight", "MetaLeft"] } },
		{ connectionId: 8, message: { type: "duck", ducked: false, level: 1 } },
	]);
});

test("keys.watch rejects non-whitelisted codes and reports codes this OS's helper can't watch", async () => {
	const service = create("darwin", recordingHost());
	await service.start();
	expect(() => service.watchKeys(1, ["KeyA"])).toThrow("only modifier, function, lock and media keys");
	expect(() => service.watchKeys(1, "AltRight")).toThrow("codes must be an array");
	expect(service.watchKeys(1, ["AltRight", "F22", "AltRight"])).toEqual({ unsupported: ["F22"] });
	expect(() => service.duck(1, 2)).toThrow("level must be a number from 0 to 1");
});

test("macOS: needs-install, then install downloads, unzips and loads the helper LaunchAgent", async () => {
	const zip = new TextEncoder().encode("zip-bytes");
	const manifest: HelperManifest = {
		version: 3,
		tag: "helper-v3",
		assets: { "darwin-universal": { name: "bgb-helper-macos-universal.zip", sha256: sha256Hex(zip) } },
	};
	const commands: string[][] = [];
	const run: CommandRunner = async (argv) => {
		commands.push([...argv]);
		if (argv[0] === "ditto") {
			const macos = path.join(argv[4] ?? "", HELPER_APP_NAME, "Contents", "MacOS");
			await mkdir(macos, { recursive: true });
			await writeFile(path.join(macos, "bgb-helper"), "");
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const fetched: string[] = [];
	const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
		fetched.push(String(input));
		return new Response(zip);
	};
	const recorder = recordingHost();
	const service = create("darwin", recorder, { manifest, run, fetch: fakeFetch });
	await service.start();
	expect(service.snapshot()).toEqual({ keys: { state: "needs-install" }, media: { state: "needs-install" } });

	await service.install();
	expect(fetched).toEqual(["https://github.com/Unravl/better-grok-bot/releases/download/helper-v3/bgb-helper-macos-universal.zip"]);
	expect(commands.map((argv) => argv.slice(0, 3).join(" "))).toEqual([
		`launchctl bootout gui/501/${HELPER_LABEL}`,
		"ditto -x -k",
		"launchctl bootstrap gui/501",
	]);
	const plist = await readFile(path.join(launchAgentsDir, `${HELPER_LABEL}.plist`), "utf8");
	expect(plist).toContain(`<string>${path.join(paths.helpers, HELPER_APP_NAME, "Contents", "MacOS", "bgb-helper")}</string>`);
	expect(plist).toContain(`<key>BGB_DATA_DIR</key>\n\t\t<string>${paths.root}</string>`);
	expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
	expect((await readFile(path.join(paths.helpers, "version.txt"), "utf8")).trim()).toBe("3");
	expect(service.snapshot()).toEqual({ keys: { state: "starting" }, media: { state: "ready" } });
	expect(recorder.broadcasts.map((b) => (b.data as { state: string }).state)).toContain("installing");

	service.helperOpened(3);
	service.helperMessage(3, hello("darwin", "denied", true));
	expect(service.snapshot().keys.state).toBe("needs-permission");
	service.helperMessage(3, { type: "access", keys: "granted" });
	expect(service.snapshot().keys.state).toBe("ready");
});

test("macOS: a download with a wrong checksum fails the install and installs nothing", async () => {
	const recorder = recordingHost();
	const service = create("darwin", recorder, { fetch: async () => new Response("tampered") });
	await service.start();
	await expect(service.install()).rejects.toThrow("checksum mismatch");
	expect(existsSync(path.join(launchAgentsDir, `${HELPER_LABEL}.plist`))).toBe(false);
	expect(service.snapshot().keys.state).toBe("needs-install");
	expect(service.snapshot().keys.detail).toContain("checksum mismatch");
});

test("macOS: a failed launchctl bootstrap removes the partial install and is reported until a retry succeeds", async () => {
	let bootstrapFails = true;
	const run: CommandRunner = async (argv) => {
		if (argv[0] === "ditto") {
			const macos = path.join(paths.helpers, HELPER_APP_NAME, "Contents", "MacOS");
			await mkdir(macos, { recursive: true });
			await writeFile(path.join(macos, "bgb-helper"), "");
		}
		if (argv[1] === "bootstrap" && bootstrapFails) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const service = create("darwin", recordingHost(), { run, env: { BGB_HELPER_PATH: "/opt/Helper.app" } });
	await service.start();
	await expect(service.install()).rejects.toThrow("Bootstrap failed");
	expect(existsSync(path.join(launchAgentsDir, `${HELPER_LABEL}.plist`))).toBe(false);
	expect(existsSync(path.join(paths.helpers, HELPER_APP_NAME))).toBe(false);
	expect(existsSync(path.join(paths.helpers, "version.txt"))).toBe(false);
	expect(service.snapshot()).toEqual({
		keys: { state: "needs-install", detail: "install failed: launchctl bootstrap failed: Bootstrap failed: 5: Input/output error" },
		media: { state: "needs-install" },
	});

	bootstrapFails = false;
	await service.install();
	expect(service.snapshot()).toEqual({ keys: { state: "starting" }, media: { state: "ready" } });
});

test("macOS: a failed reinstall over an installed helper shows the error until the helper connects", async () => {
	await installMacHelper();
	const service = create("darwin", recordingHost(), { fetch: async () => new Response("tampered") });
	await service.start();
	expect(service.snapshot().keys).toEqual({ state: "starting" });
	await expect(service.install()).rejects.toThrow("checksum mismatch");
	expect(service.snapshot().keys.state).toBe("needs-install");
	expect(service.snapshot().keys.detail).toContain("checksum mismatch");
	expect(service.snapshot().media).toEqual({ state: "needs-install" });

	service.helperOpened(4);
	service.helperMessage(4, hello("darwin"));
	expect(service.snapshot()).toEqual({ keys: { state: "ready" }, media: { state: "ready" } });
});

test("a renderer that starts watching a held key gets down:true; existing watchers get nothing new", async () => {
	await installMacHelper();
	const recorder = recordingHost();
	const service = create("darwin", recorder);
	await service.start();
	service.watchKeys(1, ["AltRight"]);
	service.helperOpened(100);
	service.helperMessage(100, hello("darwin"));
	service.helperMessage(100, { type: "key", code: "AltRight", down: true });
	expect(recorder.events).toEqual([{ connectionId: 1, event: "keys.key", data: { code: "AltRight", down: true } }]);

	recorder.events.length = 0;
	service.watchKeys(2, ["AltRight", "ControlLeft"]);
	expect(recorder.events).toEqual([{ connectionId: 2, event: "keys.key", data: { code: "AltRight", down: true } }]);

	// Re-sending an unchanged watch replays nothing; the duplicate helper frame stays deduplicated.
	recorder.events.length = 0;
	service.watchKeys(2, ["AltRight", "ControlLeft"]);
	service.watchKeys(1, ["AltRight", "F5"]);
	service.helperMessage(100, { type: "key", code: "AltRight", down: true });
	expect(recorder.events).toEqual([]);

	service.helperMessage(100, { type: "key", code: "AltRight", down: false });
	expect(recorder.events).toEqual([
		{ connectionId: 1, event: "keys.key", data: { code: "AltRight", down: false } },
		{ connectionId: 2, event: "keys.key", data: { code: "AltRight", down: false } },
	]);
});

interface FakeChild {
	file: string;
	env: Record<string, string>;
	exit(code: number): void;
	killed: boolean;
}

function fakeSpawner(): { spawn: HelperSpawner; children: FakeChild[] } {
	const children: FakeChild[] = [];
	const spawn: HelperSpawner = (file, env) => {
		const exited = Promise.withResolvers<number>();
		const child: FakeChild = { file, env, exit: (code) => exited.resolve(code), killed: false };
		children.push(child);
		const process: HelperProcess = {
			pid: 1000 + children.length,
			exited: exited.promise,
			kill: () => {
				child.killed = true;
				exited.resolve(137);
			},
		};
		return process;
	};
	return { spawn, children };
}

test("Linux: the helper child starts on the first watch, connects, and quits when idle", async () => {
	const { spawn, children } = fakeSpawner();
	const recorder = recordingHost(39555, "tok", (message) => {
		if (message.type === "quit") for (const child of children) child.exit(0);
	});
	const service = create("linux", recorder, {
		env: { DISPLAY: ":0", BGB_HELPER_PATH: "/opt/helper" },
		spawn,
		idleMs: 20,
		linuxDucker: new LinuxDucker({ run: async () => ({ code: 0, stdout: "pactl 16.1", stderr: "" }), log: nullLogger }),
	});
	await service.start();
	expect(service.snapshot()).toEqual({ keys: { state: "ready" }, media: { state: "ready" } });

	expect(service.watchKeys(1, ["AltRight", "Fn"])).toEqual({ unsupported: ["Fn"] });
	await waitFor(() => children.length === 1, 1_000, "spawn");
	expect(children[0]?.file).toBe("/opt/helper");
	expect(children[0]?.env.BGB_BRIDGE_URL).toBe("ws://127.0.0.1:39555/helper");
	expect(children[0]?.env.BGB_HELPER_TOKEN).toBe("tok");
	expect(children[0]?.env.DISPLAY).toBe(":0");
	expect(service.snapshot().keys).toEqual({ state: "starting" });

	service.helperOpened(9);
	service.helperMessage(9, hello("linux", "granted", false));
	expect(service.snapshot()).toEqual({ keys: { state: "ready" }, media: { state: "ready" } });
	expect(recorder.helperFrames).toEqual([{ connectionId: 9, message: { type: "watch", codes: ["AltRight"] } }]);

	service.watchKeys(1, []);
	await waitFor(
		() => recorder.helperFrames.some((frame) => (frame.message as { type: string }).type === "quit"),
		1_000,
		"idle quit",
	);
	children[0]?.exit(0);
	service.helperClosed(9);
	expect(service.snapshot().keys).toEqual({ state: "ready" });
	expect(children).toHaveLength(1);
});

test("Linux: five failed starts in a row end in keys error; a new watch retries", async () => {
	const { spawn, children } = fakeSpawner();
	const service = create("linux", recordingHost(), {
		env: { DISPLAY: ":0", BGB_HELPER_PATH: "/opt/helper" },
		spawn,
		restartBaseMs: 1,
		linuxDucker: new LinuxDucker({ run: async () => ({ code: 1, stdout: "", stderr: "" }), log: nullLogger }),
	});
	await service.start();
	expect(service.snapshot().media.state).toBe("unsupported");
	service.watchKeys(1, ["F13"]);
	for (let i = 1; i <= 5; i++) {
		await waitFor(() => children.length === i, 2_000, `start ${i}`);
		children[i - 1]?.exit(3);
	}
	await waitFor(() => service.snapshot().keys.state === "error", 1_000, "error state");
	expect(service.snapshot().keys.detail).toBe("helper exited with code 3 before connecting");
	expect(children).toHaveLength(5);

	service.watchKeys(1, []);
	service.watchKeys(1, ["F13"]);
	await waitFor(() => children.length === 6, 1_000, "retry");
});

test("Windows: an active duck starts the helper even without key watches", async () => {
	const { spawn, children } = fakeSpawner();
	const recorder = recordingHost(1, "token", (message) => {
		if (message.type === "quit") for (const child of children) child.exit(0);
	});
	const service = create("win32", recorder, { env: { BGB_HELPER_PATH: "C:\\helper.exe" }, spawn });
	await service.start();
	service.duck(4, 0.4);
	await waitFor(() => children.length === 1, 1_000, "spawn");
	service.helperOpened(2);
	service.helperMessage(2, hello("win32"));
	expect(recorder.helperFrames).toContainEqual({ connectionId: 2, message: { type: "duck", ducked: true, level: 0.4 } });
	service.helperMessage(2, { ...hello("win32"), media: false });
	expect(service.snapshot().media.state).toBe("unsupported");
});

test("Windows: a helper whose keyboard hook fails reports keys error, then recovers on granted", async () => {
	const { spawn, children } = fakeSpawner();
	const recorder = recordingHost(1, "token", (message) => {
		if (message.type === "quit") for (const child of children) child.exit(0);
	});
	const service = create("win32", recorder, { env: { BGB_HELPER_PATH: "C:\\helper.exe" }, spawn });
	await service.start();
	service.watchKeys(1, ["AltRight"]);
	await waitFor(() => children.length === 1, 1_000, "spawn");
	service.helperOpened(2);
	service.helperMessage(2, hello("win32"));
	recorder.helperFrames.length = 0;

	service.helperMessage(2, { type: "access", keys: "denied" });
	expect(service.snapshot()).toEqual({
		keys: { state: "error", detail: "the helper could not install its keyboard hook" },
		media: { state: "ready" },
	});
	expect(recorder.helperFrames).toEqual([]);

	service.helperMessage(2, { type: "access", keys: "granted" });
	expect(service.snapshot().keys).toEqual({ state: "ready" });
	expect(recorder.helperFrames).toEqual([{ connectionId: 2, message: { type: "watch", codes: ["AltRight"] } }]);
});

test("Wayland and unpublished helpers make keys unsupported", async () => {
	const wayland = create("linux", recordingHost(), {
		env: { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" },
		linuxDucker: new LinuxDucker({ run: async () => ({ code: 0, stdout: "pactl 17.0", stderr: "" }), log: nullLogger }),
	});
	await wayland.start();
	expect(wayland.snapshot().keys.state).toBe("unsupported");
	expect(wayland.snapshot().media.state).toBe("ready");
	expect(wayland.watchKeys(1, ["AltRight"])).toEqual({ unsupported: ["AltRight"] });
	await expect(wayland.install()).rejects.toThrow("Wayland");

	const empty = create("darwin", recordingHost(), { manifest: { version: 1, tag: "helper-v1", assets: {} } });
	await empty.start();
	expect(empty.snapshot()).toEqual({
		keys: { state: "unsupported", detail: "no native helper has been published yet" },
		media: { state: "unsupported", detail: "no native helper has been published yet" },
	});
	const arm = create("win32", recordingHost(), { arch: "arm64" });
	await arm.start();
	expect(arm.snapshot().keys).toEqual({ state: "unsupported", detail: "no native helper is published for win32-arm64" });
});

test("Linux ducking goes to pactl, not the helper", async () => {
	const commands: string[] = [];
	const run: CommandRunner = async (argv) => {
		commands.push(argv.slice(1).join(" "));
		if (argv[1] === "--version") return { code: 0, stdout: "pactl 16.1", stderr: "" };
		return { code: 0, stdout: "[]", stderr: "" };
	};
	const linuxDucker = new LinuxDucker({ run, log: nullLogger });
	const recorder = recordingHost();
	const service = create("linux", recorder, { env: { DISPLAY: ":0" }, linuxDucker });
	await service.start();
	service.duck(1, 0.5);
	await linuxDucker.request(0.5);
	expect(commands).toContain("-f json list sink-inputs");
	expect(recorder.helperFrames).toEqual([]);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type CoreContext, createContext } from "../context.ts";
import { nullLogger } from "../log.ts";
import { rendererUrl } from "../paths.ts";
import type { HookRecord, PlatformAdapter } from "../platform/types.ts";
import { mutateState, readState } from "../state.ts";
import { type Call, type FakeHost, fakeHost, recordingAdapter } from "./test-fakes.ts";
import { clearDataExceptBin, deferredDeleteCommand, runUninstall } from "./uninstall.ts";

let root: string;
let calls: Call[];
let host: FakeHost;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "bgb-uninstall-"));
	calls = [];
	host = fakeHost(path.join(root, "home"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function context(adapter: Partial<PlatformAdapter> = {}): Promise<CoreContext> {
	return createContext({ dataDir: path.join(root, "data"), platform: recordingAdapter(calls, adapter), log: nullLogger });
}

const names = (): string[] => calls.map((call) => call.name);

test("a hook changed by something else is reported and left untouched", async () => {
	const ctx = await context({ hookRemove: async () => "not-owned" });
	const record: HookRecord = { kind: "launchctl", value: rendererUrl(ctx.paths) };
	await mutateState(ctx.paths, (state) => {
		state.hook = record;
	});

	expect(await runUninstall(ctx, { purge: false, yes: true }, host)).toBe(0);

	expect(names()).toEqual(["stopAgent", "autostartRemove", "hookRemove"]);
	expect(calls[2]?.args).toEqual([record]);
	expect(host.out).toContain("The Grok Bot hook was changed by something else; left it untouched.");
	expect((await readState(ctx.paths)).hook).toBeNull();
	expect(existsSync(ctx.paths.root)).toBe(true);
});

test("a hook that is still active after state was lost is removed", async () => {
	const ctx = await context({ hookStatus: async () => ({ state: "active" }) });

	expect(await runUninstall(ctx, { purge: false, yes: true }, host)).toBe(0);

	const removed = calls.find((call) => call.name === "hookRemove")?.args[0] as HookRecord | undefined;
	expect(removed?.value).toBe(rendererUrl(ctx.paths));
	expect(removed?.kind).toBe(
		ctx.platform.id === "darwin" ? "launchctl" : ctx.platform.id === "win32" ? "user-env" : "desktop-entry",
	);
	expect(host.out).not.toContain("The Grok Bot hook was changed by something else; left it untouched.");
});

test.skipIf(process.platform === "win32")("--purge deletes DATA once everything else is removed", async () => {
	const ctx = await context({ id: "linux" });
	expect(await runUninstall(ctx, { purge: true, yes: true }, host)).toBe(0);
	expect(existsSync(ctx.paths.root)).toBe(false);
	expect(host.out.at(-1)).toBe("Quit and reopen Grok Bot to finish; it will start without Better Grok Bot.");
});

test("a failed step keeps DATA, still attempts the rest and exits 1", async () => {
	const ctx = await context({
		stopAgent: async () => {
			throw new Error("agent stuck");
		},
	});

	expect(await runUninstall(ctx, { purge: true, yes: true }, host)).toBe(1);

	expect(names()).toContain("autostartRemove");
	expect(host.err).toEqual([
		"bgb: could not stop the agent: agent stuck",
		`bgb: kept ${ctx.paths.root} because uninstall did not finish; run it again`,
	]);
	expect(existsSync(ctx.paths.root)).toBe(true);
});

test("without --yes it asks, and does nothing when declined or without a terminal", async () => {
	const ctx = await context();
	const declining = fakeHost(path.join(root, "home"), { interactive: true, answers: [false] });
	expect(await runUninstall(ctx, { purge: true, yes: false }, declining)).toBe(1);
	expect(declining.questions).toEqual([`Uninstall Better Grok Bot and delete ${ctx.paths.root} (plugins, themes, settings)?`]);

	expect(await runUninstall(ctx, { purge: false, yes: false }, host)).toBe(1);
	expect(host.err).toEqual(["bgb: uninstall asks for confirmation; pass --yes to run it without a terminal"]);
	expect(names()).toEqual([]);
});

test("--purge keeps DATA and the hook record while a foreign entry still points at this install", async () => {
	const ctx = await context({ hookRemove: async () => "not-owned", hookStatus: async () => ({ state: "active" }) });
	const record: HookRecord = { kind: "launchctl", value: rendererUrl(ctx.paths) };
	await mutateState(ctx.paths, (state) => {
		state.hook = record;
	});

	expect(await runUninstall(ctx, { purge: true, yes: true }, host)).toBe(1);

	expect((await readState(ctx.paths)).hook).toEqual(record);
	expect(existsSync(ctx.paths.root)).toBe(true);
	expect(host.err.some((line) => line.includes("still hooked to"))).toBe(true);
});

test("the deferred Windows delete passes the DATA and log paths as PowerShell literals", () => {
	const dir = "C:\\Users\\a b\\x&y %USERPROFILE% $env:TEMP it's";
	const argv = deferredDeleteCommand(4242, dir, "C:\\Temp\\o'k\\bgb-uninstall.log");
	expect(argv.slice(0, -1)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand"]);
	const script = Buffer.from(argv.at(-1) ?? "", "base64").toString("utf16le");
	expect(script).toContain("Wait-Process -Id 4242");
	expect(script).toContain("$p = 'C:\\Users\\a b\\x&y %USERPROFILE% $env:TEMP it''s'");
	expect(script).toContain("$log = 'C:\\Temp\\o''k\\bgb-uninstall.log'");
	expect(script).toContain("Remove-Item -LiteralPath $p -Recurse -Force");
});

test("the Windows purge clears DATA except bin without following the current junction", async () => {
	const ctx = await context();
	const { paths } = ctx;
	const build = path.join(paths.builds, "k1", "renderer");
	await mkdir(build, { recursive: true });
	await writeFile(path.join(build, "index.html"), "x");
	await symlink(path.join(paths.builds, "k1"), paths.current, "junction");
	await mkdir(paths.bin, { recursive: true });
	await writeFile(path.join(paths.bin, "bgb.exe"), "exe");
	await mkdir(path.join(paths.plugins, "p"), { recursive: true });
	const outside = path.join(root, "outside");
	await mkdir(outside);
	await writeFile(path.join(outside, "keep"), "k");
	await symlink(outside, `${paths.current}.old`, "junction");

	expect(await clearDataExceptBin(paths)).toEqual([]);

	expect(await readdir(paths.root)).toEqual(["bin"]);
	expect(await readdir(paths.bin)).toEqual(["bgb.exe"]);
	expect(await readdir(outside)).toEqual(["keep"]);
});

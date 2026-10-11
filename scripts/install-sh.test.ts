import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { REPO_ROOT } from "./lib.ts";

const posix = process.platform === "darwin" || process.platform === "linux";
const archOf = process.arch === "arm64" ? "arm64" : "x64";
const assetName = `bgb-${process.platform}-${archOf}.tar.gz`;

let dir: string;

/** A release archive whose `bgb` records its arguments (one per line), plus a SHA256SUMS with `sumsEntry`. */
async function fakeRelease(sumsEntry?: (hex: string) => string): Promise<{ archive: string; sums: string; argsFile: string }> {
	const argsFile = path.join(dir, "args.txt");
	const bgb = path.join(dir, "bgb");
	await writeFile(bgb, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n`);
	await chmod(bgb, 0o755);
	const archive = path.join(dir, assetName);
	const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", dir, "bgb"]);
	expect(tar.exitCode).toBe(0);
	const hex = createHash("sha256").update(await readFile(archive)).digest("hex");
	const sums = path.join(dir, "SHA256SUMS");
	await writeFile(sums, `${"0".repeat(64)}  bgb-other-x64.tar.gz\n${sumsEntry ? sumsEntry(hex) : `${hex}  ${assetName}`}\n`);
	return { archive, sums, argsFile };
}

function install(env: Record<string, string>): { exitCode: number; stderr: string } {
	const result = Bun.spawnSync(["sh", path.join(REPO_ROOT, "install.sh")], {
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

describe.skipIf(!posix)("install.sh", () => {
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "bgb-install-sh-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("verifies the archive and runs a non-interactive setup with extra arguments", async () => {
		const { archive, sums, argsFile } = await fakeRelease();
		const result = install({ BGB_LOCAL_ARCHIVE: archive, BGB_LOCAL_SUMS: sums, BGB_NONINTERACTIVE: "1", BGB_SETUP_ARGS: "--no-autostart --app /x" });
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect((await readFile(argsFile, "utf8")).trim().split("\n")).toEqual(["setup", "--yes", "--no-restart", "--no-autostart", "--app", "/x"]);
	});

	test("passes BGB_APP_PATH as one --app argument even with spaces", async () => {
		const { archive, sums, argsFile } = await fakeRelease();
		const app = "/Applications/Grok Bot  Beta.app";
		const result = install({ BGB_LOCAL_ARCHIVE: archive, BGB_LOCAL_SUMS: sums, BGB_NONINTERACTIVE: "1", BGB_SETUP_ARGS: "--no-autostart", BGB_APP_PATH: app });
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect((await readFile(argsFile, "utf8")).trim().split("\n")).toEqual(["setup", "--yes", "--no-restart", "--no-autostart", "--app", app]);
	});

	test("refuses an archive whose checksum does not match", async () => {
		const { archive, sums, argsFile } = await fakeRelease(() => `${"f".repeat(64)}  ${assetName}`);
		const result = install({ BGB_LOCAL_ARCHIVE: archive, BGB_LOCAL_SUMS: sums, BGB_NONINTERACTIVE: "1" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(`checksum mismatch for ${assetName}`);
		expect(await Bun.file(argsFile).exists()).toBe(false);
	});

	test("refuses SHA256SUMS without a line for this archive", async () => {
		const { archive, sums } = await fakeRelease(() => "");
		const result = install({ BGB_LOCAL_ARCHIVE: archive, BGB_LOCAL_SUMS: sums, BGB_NONINTERACTIVE: "1" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(`SHA256SUMS has no entry for ${assetName}`);
	});
});

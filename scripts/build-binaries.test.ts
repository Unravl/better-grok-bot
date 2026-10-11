import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseSums, REPO_ROOT, sha256File } from "./lib.ts";

let dir: string;

function archive(name: string): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync([process.execPath, path.join(REPO_ROOT, "scripts", "build-binaries.ts"), "archive", "--dir", dir, "--name", name], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString() };
}

describe("build-binaries archive", () => {
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "bgb-archive-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("zips bgb.exe and bgbw.exe unchanged and records the hash once per asset", async () => {
		await writeFile(path.join(dir, "bgb.exe"), "bgb-bytes");
		await writeFile(path.join(dir, "bgbw.exe"), "bgbw-bytes");
		expect(archive("bgb-windows-x64").exitCode).toBe(0);
		await writeFile(path.join(dir, "bgb.exe"), "bgb-bytes-2");
		const second = archive("bgb-windows-x64");
		expect(second.exitCode).toBe(0);
		const zip = path.join(dir, "bgb-windows-x64.zip");
		expect(second.stdout).toBe(zip);
		const files = unzipSync(new Uint8Array(await readFile(zip)));
		expect(Object.keys(files).sort()).toEqual(["bgb.exe", "bgbw.exe"]);
		expect(new TextDecoder().decode(files["bgb.exe"])).toBe("bgb-bytes-2");
		const sumsText = await readFile(path.join(dir, "SHA256SUMS"), "utf8");
		expect(sumsText.trim().split("\n")).toHaveLength(1);
		expect(parseSums(sumsText).get("bgb-windows-x64.zip")).toBe(await sha256File(zip));
	});

	test.skipIf(process.platform === "win32")("tars bgb with its executable bit", async () => {
		await writeFile(path.join(dir, "bgb"), "#!/bin/sh\n");
		await chmod(path.join(dir, "bgb"), 0o755);
		expect(archive("bgb-linux-arm64").exitCode).toBe(0);
		const listing = Bun.spawnSync(["tar", "-tvzf", path.join(dir, "bgb-linux-arm64.tar.gz")]).stdout.toString().trim();
		expect(listing).toMatch(/^-rwxr-xr-x .* bgb$/);
	});

	test("refuses a Windows asset without bgbw.exe", async () => {
		await writeFile(path.join(dir, "bgb.exe"), "x");
		const result = archive("bgb-windows-arm64");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("bgbw.exe is missing");
	});
});

#!/usr/bin/env bun
/**
 * Compiles and packages the `bgb` binaries.
 *
 *   bun scripts/build-binaries.ts compile (--host | --target <bun-target>) --out <dir>
 *   bun scripts/build-binaries.ts archive --dir <dir> --name <bgb-darwin-arm64|…>
 *
 * `compile` regenerates `core/generated/embedded.ts` (strict), compiles `core/cli.ts` plus the
 * patch worker into `<out>/bgb[.exe]`, re-signs darwin binaries ad hoc on macOS hosts and, for
 * Windows targets on Windows hosts, builds `bgbw.exe` beside `bgb.exe`.
 * `archive` packages the files in `<dir>` unchanged into the release asset and records its hash in
 * `<dir>/SHA256SUMS`; it never recompiles, so signed binaries stay signed.
 */
import { zipSync } from "fflate";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import packageJson from "../package.json";
import { REPO_ROOT, run, runMain, ScriptError, sha256File } from "./lib.ts";

type TargetOs = "darwin" | "linux" | "windows";
type TargetArch = "x64" | "arm64";

const BUN_TARGETS = [
	"bun-darwin-arm64",
	"bun-darwin-x64",
	"bun-linux-x64",
	"bun-linux-arm64",
	"bun-windows-x64",
	"bun-windows-arm64",
] as const;

const ASSET_NAMES = [
	"bgb-darwin-arm64",
	"bgb-darwin-x64",
	"bgb-linux-x64",
	"bgb-linux-arm64",
	"bgb-windows-x64",
	"bgb-windows-arm64",
] as const;

const USAGE = `usage:
  bun scripts/build-binaries.ts compile (--host | --target <${BUN_TARGETS.join("|")}>) --out <dir>
  bun scripts/build-binaries.ts archive --dir <dir> --name <${ASSET_NAMES.join("|")}>`;

function hostOs(): TargetOs {
	switch (process.platform) {
		case "darwin":
			return "darwin";
		case "win32":
			return "windows";
		case "linux":
			return "linux";
		default:
			throw new ScriptError(`unsupported host OS ${process.platform}`);
	}
}

function hostArch(): TargetArch {
	if (process.arch === "x64" || process.arch === "arm64") return process.arch;
	throw new ScriptError(`unsupported host architecture ${process.arch}`);
}

/** `<x.y.z>.0` for the Windows file version (pre-release suffix dropped). */
function windowsFileVersion(version: string): string {
	const core = /^(\d+\.\d+\.\d+)/.exec(version)?.[1];
	if (!core) throw new ScriptError(`package.json version ${version} is not semver`);
	return `${core}.0`;
}

async function compile(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: { host: { type: "boolean" }, target: { type: "string" }, out: { type: "string" } },
		strict: true,
	});
	if (!values.out || values.host === (values.target !== undefined)) throw new ScriptError(USAGE, 2);
	let os: TargetOs;
	let arch: TargetArch;
	if (values.target !== undefined) {
		const target = values.target;
		if (!(BUN_TARGETS as readonly string[]).includes(target)) throw new ScriptError(`unknown target ${target}\n${USAGE}`, 2);
		const [, targetOs, targetArch] = target.split("-") as [string, TargetOs, TargetArch];
		os = targetOs;
		arch = targetArch;
	} else {
		os = hostOs();
		arch = hostArch();
	}
	const out = path.resolve(values.out);
	await mkdir(out, { recursive: true });
	const binary = path.join(out, os === "windows" ? "bgb.exe" : "bgb");

	console.error("[build] generating core/generated/embedded.ts");
	await run([process.execPath, "core/scripts/embed.ts"], { cwd: REPO_ROOT, inherit: true });

	const command = [
		process.execPath,
		"build",
		"core/cli.ts",
		"core/patch-worker.ts",
		"--compile",
		"--no-compile-autoload-dotenv",
		"--no-compile-autoload-bunfig",
		// @electron/asar requires `original-fs` only inside Electron; never reached in bgb.
		"--external",
		"original-fs",
		"--minify",
		"--define",
		"BGB_COMPILED=true",
		"--outfile",
		binary,
	];
	if (values.target !== undefined) command.push(`--target=${values.target}`);
	if (os === "windows" && hostOs() === "windows") {
		command.push(
			"--windows-title",
			"Better Grok Bot",
			"--windows-publisher",
			"Better Grok Bot contributors",
			"--windows-version",
			windowsFileVersion(packageJson.version),
			"--windows-description",
			"Better Grok Bot CLI",
		);
	}
	console.error(`[build] compiling ${path.relative(REPO_ROOT, binary) || binary} for ${os}-${arch}`);
	await run(command, { cwd: REPO_ROOT, inherit: true });

	if (os === "darwin") {
		if (hostOs() === "darwin") {
			// Bun's embedded ad-hoc signature fails `codesign -v` (local://SPIKES.md); re-sign ad hoc.
			// Release jobs replace it with a Developer ID signature afterwards when secrets exist.
			await run(["codesign", "--force", "--sign", "-", binary], { inherit: true });
			await run(["codesign", "-v", binary], { inherit: true });
		} else {
			console.error("[build] warning: darwin binary not re-signed (codesign needs a macOS host)");
		}
	}

	if (os === "windows") {
		if (hostOs() === "windows") {
			const triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
			console.error(`[build] building bgbw.exe (${triple})`);
			await run(["cargo", "build", "--release", "-p", "bgbw", "--target", triple], {
				cwd: path.join(REPO_ROOT, "native"),
				inherit: true,
			});
			await copyFile(path.join(REPO_ROOT, "native", "target", triple, "release", "bgbw.exe"), path.join(out, "bgbw.exe"));
		} else {
			console.error("[build] warning: bgbw.exe skipped (needs a Windows host with cargo); `archive` will refuse this dir");
		}
	}
	console.error(`[build] done: ${binary}`);
}

async function archive(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: { dir: { type: "string" }, name: { type: "string" } },
		strict: true,
	});
	if (!values.dir || !values.name) throw new ScriptError(USAGE, 2);
	const name = values.name;
	if (!(ASSET_NAMES as readonly string[]).includes(name)) throw new ScriptError(`unknown asset name ${name}\n${USAGE}`, 2);
	const dir = path.resolve(values.dir);
	const windows = name.startsWith("bgb-windows-");
	const members = windows ? ["bgb.exe", "bgbw.exe"] : ["bgb"];
	for (const member of members) {
		const info = await stat(path.join(dir, member)).catch(() => null);
		if (!info?.isFile()) throw new ScriptError(`${path.join(dir, member)} is missing`);
	}
	const fileName = `${name}${windows ? ".zip" : ".tar.gz"}`;
	const assetPath = path.join(dir, fileName);
	if (windows) {
		const files: Record<string, Uint8Array> = {};
		for (const member of members) files[member] = new Uint8Array(await readFile(path.join(dir, member)));
		await writeFile(assetPath, zipSync(files, { level: 9 }));
	} else {
		// System tar keeps the executable bit; `-C` stores the bare file name.
		await run(["tar", "-czf", assetPath, "-C", dir, ...members], { inherit: true });
	}
	const line = `${await sha256File(assetPath)}  ${fileName}`;
	const sumsPath = path.join(dir, "SHA256SUMS");
	const existing = (await readFile(sumsPath, "utf8").catch(() => ""))
		.split("\n")
		.filter((entry) => entry.trim() !== "" && !entry.endsWith(`  ${fileName}`));
	await writeFile(sumsPath, [...existing, line].join("\n") + "\n");
	console.log(assetPath);
	console.error(`[archive] ${line}`);
}

await runMain("build-binaries", async () => {
	const [command, ...rest] = process.argv.slice(2);
	switch (command) {
		case "compile":
			await compile(rest);
			return;
		case "archive":
			await archive(rest);
			return;
		default:
			throw new ScriptError(USAGE, 2);
	}
});

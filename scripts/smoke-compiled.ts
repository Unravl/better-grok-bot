#!/usr/bin/env bun
/**
 * Proves a compiled `bgb` works where no checkout file is reachable:
 *
 *   bun scripts/smoke-compiled.ts --bin dist/bgb[.exe]
 *
 * The binary (plus `bgbw.exe` on Windows) is copied into a fresh temp dir and every command runs
 * with `cwd` = another empty temp dir and `BGB_DATA_DIR` = a third. It checks `--version`,
 * `agent --self-test`, plugin authoring (`plugin new`/`plugin build`, which run `Bun.build` and
 * `import()` inside the binary), `plugins install`, and a build whose community string patch runs
 * in the embedded patch worker.
 */
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { makeFixtureAsar } from "../core/test/fixtures.ts";
import packageJson from "../package.json";
import { run, runMain, ScriptError } from "./lib.ts";

const SMOKE_PLUGIN_TS = `import { definePlugin } from "@better-grok-bot/sdk";

export default definePlugin({
	id: "ci-smoke",
	name: "CI smoke",
	description: "Compiled-binary smoke test",
	version: "1.0.0",
	apiVersion: 1,
	patches: [
		{
			id: "smoke",
			file: /^assets\\/smoke\\.js$/,
			find: /SMOKE_ORIGINAL/,
			replace: "SMOKE_PATCHED",
			expect: 1,
		},
	],
	runtime: "runtime.ts",
});
`;

interface BuildJson {
	key: string;
	dir: string;
	plugins: { id: string; source: string; state: string; errors: string[] }[];
}

/** On Apple silicon, an x86_64 binary runs through Rosetta; `null` means Rosetta is missing. */
async function execPrefix(binary: string): Promise<string[] | null> {
	if (process.platform !== "darwin" || process.arch !== "arm64") return [];
	const archs = (await run(["lipo", "-archs", binary])).stdout.trim().split(/\s+/);
	if (archs.includes("arm64")) return [];
	const rosetta = await run(["arch", "-x86_64", "/usr/bin/true"], { allowFail: true });
	return rosetta.exitCode === 0 ? ["arch", "-x86_64"] : null;
}

await runMain("smoke-compiled", async () => {
	const { values } = parseArgs({ args: process.argv.slice(2), options: { bin: { type: "string" } }, strict: true });
	if (!values.bin) throw new ScriptError("usage: bun scripts/smoke-compiled.ts --bin <path to bgb[.exe]>", 2);
	const source = path.resolve(values.bin);
	const exe = process.platform === "win32" ? ".exe" : "";

	const prefix = await execPrefix(source);
	if (prefix === null) {
		console.log("skipped: x86_64 binary on Apple silicon without Rosetta");
		return 0;
	}

	const binDir = await mkdtemp(path.join(tmpdir(), "bgb-smoke-bin-"));
	const cwd = await mkdtemp(path.join(tmpdir(), "bgb-smoke-cwd-"));
	const dataDir = await mkdtemp(path.join(tmpdir(), "bgb-smoke-data-"));
	const work = await mkdtemp(path.join(tmpdir(), "bgb-smoke-work-"));
	try {
		const bin = path.join(binDir, `bgb${exe}`);
		await copyFile(source, bin);
		if (process.platform === "win32") {
			const bgbw = path.join(path.dirname(source), "bgbw.exe");
			if (await stat(bgbw).catch(() => null)) await copyFile(bgbw, path.join(binDir, "bgbw.exe"));
		}
		const bgb = async (...args: string[]): Promise<string> => {
			console.error(`$ bgb ${args.join(" ")}`);
			const result = await run([...prefix, bin, ...args], { cwd, env: { BGB_DATA_DIR: dataDir }, timeoutMs: 180_000 });
			if (result.stderr.trim()) console.error(result.stderr.trimEnd());
			return result.stdout;
		};

		const version = (await bgb("--version")).trim();
		if (version !== packageJson.version) throw new ScriptError(`bgb --version printed "${version}", expected "${packageJson.version}"`);

		const selfTest = (await bgb("agent", "--self-test")).trim();
		if (selfTest !== `ok ${packageJson.version}`) throw new ScriptError(`bgb agent --self-test printed "${selfTest}"`);

		const pluginDir = path.join(work, "ci-smoke");
		await bgb("plugin", "new", "ci-smoke", "--dir", pluginDir);
		await writeFile(path.join(pluginDir, "plugin.ts"), SMOKE_PLUGIN_TS);
		const packagePath = path.join(work, "ci-smoke.bgbplugin");
		await bgb("plugin", "build", pluginDir, "--out", packagePath);
		await bgb("plugins", "install", packagePath, "--yes");

		const asarPath = await makeFixtureAsar(work, {
			version: "0.68.1",
			renderer: {
				"index.html": '<script src="./assets/app.js"></script>',
				"assets/app.js": "",
				"assets/smoke.js": "SMOKE_ORIGINAL",
			},
		});
		const output = await bgb("build", "--app", asarPath, "--json");
		const built = JSON.parse(output) as BuildJson;
		const plugin = built.plugins.find((entry) => entry.id === "ci-smoke");
		if (plugin?.state !== "active") {
			throw new ScriptError(`ci-smoke is ${plugin?.state ?? "missing"} after the build: ${JSON.stringify(plugin?.errors ?? [])}`);
		}
		const patched = await readFile(path.join(built.dir, "renderer", "assets", "smoke.js"), "utf8");
		if (!patched.includes("SMOKE_PATCHED")) throw new ScriptError(`renderer/assets/smoke.js was not patched: ${JSON.stringify(patched)}`);

		console.log(`ok ${packageJson.version}: version, self-test, plugin new/build/install and patched build`);
		return 0;
	} finally {
		for (const dir of [binDir, cwd, dataDir, work]) await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

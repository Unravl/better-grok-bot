#!/usr/bin/env bun
/**
 * Prepares a release:
 *
 *   bun scripts/bump-version.ts <x.y.z> [--root <dir>]
 *
 * Sets the root `package.json` version (unchanged when it already is `x.y.z`, e.g. the first
 * release), renames `## [Unreleased]` in `CHANGELOG.md` to `## [x.y.z] - <UTC date>` and adds a
 * fresh empty `## [Unreleased]` above it. A version that already has a changelog section is refused.
 */
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT, runMain, ScriptError } from "./lib.ts";

await runMain("bump-version", async () => {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: { root: { type: "string" } },
		allowPositionals: true,
		strict: true,
	});
	const version = positionals[0];
	if (!version || positionals.length !== 1) throw new ScriptError("usage: bun scripts/bump-version.ts <x.y.z> [--root <dir>]", 2);
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new ScriptError(`${version} is not a semver version`, 2);
	const root = path.resolve(values.root ?? REPO_ROOT);

	const packagePath = path.join(root, "package.json");
	const packageText = await readFile(packagePath, "utf8");
	const parsed: unknown = JSON.parse(packageText);
	const current = parsed && typeof parsed === "object" && "version" in parsed ? parsed.version : undefined;
	// The first release's version is already set at bootstrap; only the changelog is finalized then.
	// Replace only the top-level "version" value so the file keeps its formatting.
	const versionLine = /^(\t| {2})"version":\s*"[^"]*"/m;
	if (!versionLine.test(packageText)) throw new ScriptError(`no top-level "version" field in ${packagePath}`);
	const nextPackage = packageText.replace(versionLine, (_line, indent: string) => `${indent}"version": "${version}"`);

	const changelogPath = path.join(root, "CHANGELOG.md");
	const changelog = await readFile(changelogPath, "utf8");
	if (new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]`, "m").test(changelog)) {
		throw new ScriptError(`CHANGELOG.md already has a ${version} section`);
	}
	const unreleased = /^## \[Unreleased\][^\n]*$/m;
	if (!unreleased.test(changelog)) throw new ScriptError("CHANGELOG.md has no `## [Unreleased]` section");
	const date = new Date().toISOString().slice(0, 10);
	const nextChangelog = changelog.replace(unreleased, `## [Unreleased]\n\n## [${version}] - ${date}`);

	if (current !== version) await writeFile(packagePath, nextPackage);
	await writeFile(changelogPath, nextChangelog);
	console.log(`${String(current)} → ${version}`);
	return 0;
});

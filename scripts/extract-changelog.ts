#!/usr/bin/env bun
/**
 * Prints the `CHANGELOG.md` section of one release (used as the GitHub release notes):
 *
 *   bun scripts/extract-changelog.ts <x.y.z> [--root <dir>]
 *
 * Exits 1 when the section is missing or empty.
 */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT, runMain, ScriptError } from "./lib.ts";

await runMain("extract-changelog", async () => {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: { root: { type: "string" } },
		allowPositionals: true,
		strict: true,
	});
	const version = positionals[0]?.replace(/^v/, "");
	if (!version || positionals.length !== 1) throw new ScriptError("usage: bun scripts/extract-changelog.ts <x.y.z> [--root <dir>]", 2);
	const changelog = await readFile(path.join(path.resolve(values.root ?? REPO_ROOT), "CHANGELOG.md"), "utf8");
	const lines = changelog.split(/\r?\n/);
	const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
	if (start === -1) throw new ScriptError(`CHANGELOG.md has no ${version} section`);
	const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	const body = lines
		.slice(start + 1, next === -1 ? undefined : next)
		.join("\n")
		.trim();
	if (!body) throw new ScriptError(`the CHANGELOG.md ${version} section is empty`);
	console.log(body);
	return 0;
});

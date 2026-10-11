#!/usr/bin/env bun
/**
 * Pins the native helpers of a published helper release (maintainer, run locally):
 *
 *   bun scripts/update-helper-manifest.ts helper-vN
 *
 * Downloads the release's `helper-manifest.json` and `SHA256SUMS`, checks that every asset hash
 * agrees, and writes `native/helper-manifest.json`. Commit the result through a normal PR.
 */
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseSums, REPO_ROOT, runMain, ScriptError } from "./lib.ts";

const REPO = "Unravl/better-grok-bot";
const HELPER_ASSET_KEYS: readonly string[] = ["darwin-universal", "windows-x64", "windows-arm64", "linux-x64", "linux-arm64"];

interface HelperManifest {
	version: number;
	tag: string;
	assets: Record<string, { name: string; sha256: string }>;
}

function parseManifest(raw: unknown, tag: string): HelperManifest {
	const problems: string[] = [];
	if (!raw || typeof raw !== "object") throw new ScriptError("helper-manifest.json is not an object");
	const rawVersion = "version" in raw ? raw.version : undefined;
	const version = typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 1 ? rawVersion : null;
	const manifestTag = "tag" in raw ? raw.tag : undefined;
	const assets = "assets" in raw ? raw.assets : undefined;
	if (version === null) problems.push("version must be a positive integer");
	if (manifestTag !== tag) problems.push(`tag is ${JSON.stringify(manifestTag)}, expected ${tag}`);
	if (version !== null && `helper-v${version}` !== tag) problems.push(`version ${version} does not match tag ${tag}`);
	const parsed: HelperManifest["assets"] = {};
	if (!assets || typeof assets !== "object") {
		problems.push("assets must be an object");
	} else {
		const entries: [string, unknown][] = Object.entries(assets);
		const byKey = new Map(entries);
		for (const key of HELPER_ASSET_KEYS) {
			const asset = byKey.get(key);
			if (!asset || typeof asset !== "object" || !("name" in asset) || !("sha256" in asset)) {
				problems.push(`assets.${key} is missing`);
				continue;
			}
			const { name, sha256 } = asset;
			if (typeof name !== "string" || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
				problems.push(`assets.${key} needs a string name and a lowercase hex sha256`);
				continue;
			}
			parsed[key] = { name, sha256 };
		}
		for (const key of byKey.keys()) {
			if (!HELPER_ASSET_KEYS.includes(key)) problems.push(`unknown asset key ${key}`);
		}
	}
	if (version === null || problems.length > 0) throw new ScriptError(`invalid helper-manifest.json:\n  ${problems.join("\n  ")}`);
	return { version, tag, assets: parsed };
}

async function releaseText(tag: string, name: string): Promise<string> {
	const url = `https://github.com/${REPO}/releases/download/${tag}/${name}`;
	const response = await fetch(url, { headers: { "user-agent": "better-grok-bot-scripts" } });
	if (!response.ok) throw new ScriptError(`GET ${url} → HTTP ${response.status}`);
	return response.text();
}

await runMain("update-helper-manifest", async () => {
	const tag = process.argv[2];
	if (!tag || process.argv.length !== 3 || !/^helper-v\d+$/.test(tag)) {
		throw new ScriptError("usage: bun scripts/update-helper-manifest.ts helper-vN", 2);
	}
	const manifest = parseManifest(JSON.parse(await releaseText(tag, "helper-manifest.json")), tag);
	const sums = parseSums(await releaseText(tag, "SHA256SUMS"));
	const mismatches: string[] = [];
	for (const [key, asset] of Object.entries(manifest.assets)) {
		const listed = sums.get(asset.name);
		if (listed !== asset.sha256) mismatches.push(`${key}: ${asset.name} is ${asset.sha256} in the manifest, ${listed ?? "absent"} in SHA256SUMS`);
	}
	if (mismatches.length > 0) throw new ScriptError(`hashes disagree:\n  ${mismatches.join("\n  ")}`);
	const out = path.join(REPO_ROOT, "native", "helper-manifest.json");
	await writeFile(out, `${JSON.stringify(manifest, null, "\t")}\n`);
	console.log(`wrote ${path.relative(REPO_ROOT, out)} for ${tag} (${Object.keys(manifest.assets).length} assets)`);
	return 0;
});

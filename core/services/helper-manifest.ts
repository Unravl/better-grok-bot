import type { Platform } from "../../sdk/index.ts";
import manifestJson from "../../native/helper-manifest.json";

export type HelperAssetKey = "darwin-universal" | "windows-x64" | "windows-arm64" | "linux-x64" | "linux-arm64";

export interface HelperAsset {
	name: string;
	sha256: string;
}

/** `native/helper-manifest.json`: the published native helper release this BGB version uses. */
export interface HelperManifest {
	version: number;
	tag: string;
	assets: Partial<Record<HelperAssetKey, HelperAsset>>;
}

const ASSET_KEYS: readonly HelperAssetKey[] = ["darwin-universal", "windows-x64", "windows-arm64", "linux-x64", "linux-arm64"];

export function parseHelperManifest(value: unknown): HelperManifest {
	if (typeof value !== "object" || value === null) throw new Error("helper-manifest.json: expected an object");
	const { version, tag, assets } = value as Record<string, unknown>;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
		throw new Error("helper-manifest.json: version must be a positive integer");
	}
	if (typeof tag !== "string" || tag.length === 0) throw new Error("helper-manifest.json: tag must be a string");
	if (typeof assets !== "object" || assets === null || Array.isArray(assets)) {
		throw new Error("helper-manifest.json: assets must be an object");
	}
	const parsed: HelperManifest["assets"] = {};
	for (const [key, asset] of Object.entries(assets)) {
		if (!(ASSET_KEYS as readonly string[]).includes(key)) throw new Error(`helper-manifest.json: unknown asset ${key}`);
		const { name, sha256 } = (asset ?? {}) as Record<string, unknown>;
		if (typeof name !== "string" || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)) {
			throw new Error(`helper-manifest.json: asset ${key} needs a name and a sha256`);
		}
		parsed[key as HelperAssetKey] = { name, sha256: sha256.toLowerCase() };
	}
	return { version, tag, assets: parsed };
}

/** The manifest compiled into this binary. */
export const HELPER_MANIFEST: HelperManifest = parseHelperManifest(manifestJson);

/** The manifest key of the helper for an OS/arch, or `null` when none is built for it. */
export function helperAssetKey(platform: Platform, arch: string): HelperAssetKey | null {
	if (platform === "darwin") return "darwin-universal";
	if (arch !== "x64" && arch !== "arm64") return null;
	return platform === "win32" ? `windows-${arch}` : `linux-${arch}`;
}

export function helperDownloadUrl(manifest: HelperManifest, asset: HelperAsset): string {
	return `https://github.com/Unravl/better-grok-bot/releases/download/${manifest.tag}/${asset.name}`;
}

/** The public Grok Bot release feed (no auth). */
import { ScriptError } from "./lib.ts";

export type Format = "dmg" | "exe" | "appimage" | "deb" | "rpm";

export const FORMATS: readonly Format[] = ["dmg", "exe", "appimage", "deb", "rpm"];
export const FEED_PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-x64-user", "win32-arm64-user", "linux-x64", "linux-arm64"] as const;
export type FeedPlatform = (typeof FEED_PLATFORMS)[number];

const FEED_BASE = "https://api2.cursor.sh/updates/api/download/stable";

export interface FeedEntry {
	version: string;
	commitSha: string;
	downloadUrl: string;
	rehUrl?: string;
	debUrl?: string;
	rpmUrl?: string;
}

/** The formats each OS publishes. */
export const FORMATS_BY_OS: Record<string, readonly Format[]> = {
	darwin: ["dmg"],
	win32: ["exe"],
	linux: ["appimage", "deb", "rpm"],
};

/** `win32-x64` → `win32-x64-user`; other platforms are their own feed platform. */
export function feedPlatformOf(platform: string): string {
	return platform.startsWith("win32-") && !platform.endsWith("-user") ? `${platform}-user` : platform;
}

/** The feed field holding a format's download URL. */
export function feedUrlField(format: Format): "downloadUrl" | "debUrl" | "rpmUrl" {
	return format === "deb" ? "debUrl" : format === "rpm" ? "rpmUrl" : "downloadUrl";
}

export async function readFeed(feedPlatform: string): Promise<FeedEntry> {
	const url = `${FEED_BASE}/${feedPlatform}/sand`;
	const response = await fetch(url);
	if (!response.ok) throw new ScriptError(`GET ${url} → HTTP ${response.status}`);
	const raw: unknown = await response.json();
	const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
	if (!raw || typeof raw !== "object") throw new ScriptError(`unexpected feed response for ${feedPlatform}: ${JSON.stringify(raw)}`);
	const version = "version" in raw ? text(raw.version) : undefined;
	const commitSha = "commitSha" in raw ? text(raw.commitSha) : undefined;
	const downloadUrl = "downloadUrl" in raw ? text(raw.downloadUrl) : undefined;
	if (!version || !commitSha || !downloadUrl) throw new ScriptError(`unexpected feed response for ${feedPlatform}: ${JSON.stringify(raw)}`);
	return {
		version,
		commitSha,
		downloadUrl,
		rehUrl: "rehUrl" in raw ? text(raw.rehUrl) : undefined,
		debUrl: "debUrl" in raw ? text(raw.debUrl) : undefined,
		rpmUrl: "rpmUrl" in raw ? text(raw.rpmUrl) : undefined,
	};
}

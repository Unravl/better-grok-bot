import type { Platform } from "../../sdk/index.ts";
import { SOURCE_RECORD, hashTree } from "../plugins/package.ts";
import type { LoadedPlugin } from "../plugins/types.ts";

export interface BuildKeyInput {
	bgbVersion: string;
	embedHash: string;
	platform: Platform;
	/** sha256 of the app's asar. */
	appFingerprint: string;
	/** `DATA/builds`: built HTML pins absolute URLs under it. */
	buildsDir: string;
	bridgePort: number;
	bridgeToken: string;
	/** Every discovered plugin in discovery order, enabled or not. */
	plugins: readonly LoadedPlugin[];
	/** Every theme file, enabled or not; `bytes` undefined when unreadable. */
	themes: readonly { id: string; enabled: boolean; bytes: Uint8Array | undefined }[];
}

/**
 * sha256 over everything that shapes the renderer files or `manifest.json`: BGB version, build format,
 * `EMBED_HASH`, platform, app fingerprint, builds dir, bridge port and token hash; per plugin its id,
 * source, version, enabled flag, pre-build state, grants and errors, plus the definition and embedded
 * assets (core/bundled) or package tree bytes (community/dev); per theme its id, enabled flag and bytes.
 */
export async function computeBuildKey(input: BuildKeyInput): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	const tokenHash = new Bun.CryptoHasher("sha256").update(input.bridgeToken).digest("hex");
	hasher.update(
		`bgb ${input.bgbVersion}\0format 1\0embed ${input.embedHash}\0platform ${input.platform}\0app ${input.appFingerprint}\0builds ${input.buildsDir}\0port ${input.bridgePort}\0token ${tokenHash}\0`,
	);
	for (const plugin of input.plugins) {
		const version = plugin.definition?.version ?? plugin.pkg?.version ?? "?";
		hasher.update(
			`plugin ${plugin.id} ${plugin.source} ${version} ${plugin.enabled} ${plugin.state ?? "-"}\0grants ${JSON.stringify(plugin.granted)}\0errors ${JSON.stringify(plugin.errors)}\0`,
		);
		if (plugin.definition !== undefined) {
			// Regex sources and function replacer source are part of a definition's identity.
			const definition = JSON.stringify(plugin.definition, (_key, value: unknown) => {
				if (value instanceof RegExp) return { regexp: [value.source, value.flags] };
				if (typeof value === "function") return { function: value.toString() };
				return value;
			});
			hasher.update(`definition ${definition}\0`);
			hasher.update(`runtime ${plugin.runtimeJs ?? "-"}\0styles ${plugin.stylesCss ?? "-"}\0`);
		}
		if (plugin.dir !== undefined) {
			hasher.update(`tree ${plugin.id}\0`);
			await hashTree(hasher, plugin.dir, new Set([SOURCE_RECORD]));
		}
	}
	for (const theme of input.themes) {
		hasher.update(`theme ${theme.id} ${theme.enabled}\0`);
		if (theme.bytes === undefined) hasher.update("-\0");
		else {
			hasher.update(`${theme.bytes.byteLength}\0`);
			hasher.update(theme.bytes);
		}
	}
	return hasher.digest("hex");
}

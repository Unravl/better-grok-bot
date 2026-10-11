import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { PluginSource, PluginState } from "../../sdk/index.ts";
import { checkSupport } from "../app/asar.ts";
import { readAppPackage } from "../app/package.ts";
import { createContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { nullLogger } from "../log.ts";
import type { PlatformAdapter } from "../platform/types.ts";
import { runBuild } from "./index.ts";

export interface CheckReport {
	asar: string;
	appVersion: string | null;
	supported: boolean;
	/** Why the asar is unsupported or unreadable. */
	error?: string;
	plugins: {
		id: string;
		source: PluginSource;
		state: PluginState;
		errors: string[];
		patches: { id: string; matches: number; expected: number; ok: boolean }[];
	}[];
	/** Supported and every core/bundled plugin `active`. */
	ok: boolean;
}

/**
 * Builds the core hooks and bundled plugins against `asarPath` in a throwaway `DATA` (fresh default
 * config, no `current` pointer) and reports every patch. Never reads or writes the user's `DATA`.
 */
export async function checkAsar(asarPath: string, opts: { platform?: PlatformAdapter } = {}): Promise<CheckReport> {
	const asar = path.resolve(asarPath);
	const temp = await mkdtemp(path.join(tmpdir(), "bgb-check-"));
	try {
		let appVersion: string;
		try {
			appVersion = (await readAppPackage(asar)).version;
		} catch (error) {
			return { asar, appVersion: null, supported: false, error: errorMessage(error), plugins: [], ok: false };
		}
		const ctx = await createContext({ dataDir: path.join(temp, "data"), platform: opts.platform, log: nullLogger });
		try {
			await checkSupport(ctx, asar);
		} catch (error) {
			return { asar, appVersion, supported: false, error: errorMessage(error), plugins: [], ok: false };
		}
		const outcome = await runBuild(ctx, {
			app: { kind: "custom", root: path.dirname(asar), executable: "", asarPath: asar, version: appVersion },
			force: true,
			publish: false,
		});
		const plugins = outcome.manifest.plugins
			.filter((plugin) => plugin.source === "core" || plugin.source === "bundled")
			.map((plugin) => ({
				id: plugin.id,
				source: plugin.source,
				state: plugin.state,
				errors: plugin.errors,
				patches: plugin.patches.map((patch) => ({ id: patch.id, matches: patch.matches, expected: patch.expected, ok: patch.ok })),
			}));
		return {
			asar,
			appVersion: outcome.manifest.appVersion,
			supported: true,
			plugins,
			ok: plugins.every((plugin) => plugin.state === "active"),
		};
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}

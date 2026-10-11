import { ensureConfig } from "./config.ts";
import { type Logger, createFileLogger } from "./log.ts";
import { type DataPaths, dataPaths, defaultDataDir, ensureDataDir } from "./paths.ts";
import { loadPlatform } from "./platform/index.ts";
import type { PlatformAdapter } from "./platform/types.ts";

/** Everything host modules need; passed as the first parameter instead of module-level paths. */
export interface CoreContext {
	readonly paths: DataPaths;
	readonly platform: PlatformAdapter;
	readonly log: Logger;
	/** Entrypoint of the community-patch worker (compiled into the binary as a second entrypoint). */
	readonly patchWorkerUrl: URL;
}

export const PATCH_WORKER_URL = new URL("./patch-worker.ts", import.meta.url);

export interface CreateContextOptions {
	/** Defaults to `BGB_DATA_DIR`, then {@link defaultDataDir}. */
	dataDir?: string;
	platform?: PlatformAdapter;
	/** Defaults to the `DATA/logs/agent.log` file logger. */
	log?: Logger;
	/** Echo file-logger lines to stderr. */
	echo?: boolean;
	patchWorkerUrl?: URL;
}

/** Resolves `DATA`, ensures it and `config.json` exist, and loads the platform adapter. */
export async function createContext(opts: CreateContextOptions = {}): Promise<CoreContext> {
	const paths = dataPaths(opts.dataDir ?? (process.env.BGB_DATA_DIR || defaultDataDir()));
	await ensureDataDir(paths);
	await ensureConfig(paths);
	return Object.freeze({
		paths,
		platform: opts.platform ?? (await loadPlatform()),
		log: opts.log ?? createFileLogger(paths, { echo: opts.echo }),
		patchWorkerUrl: opts.patchWorkerUrl ?? PATCH_WORKER_URL,
	});
}

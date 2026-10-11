import { type FSWatcher, watch } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { errorMessage } from "../errors.ts";
import { type Logger, nullLogger } from "../log.ts";
import type { DataPaths } from "../paths.ts";
import type { AppInstall } from "../platform/types.ts";

interface AppSignature {
	asarPath: string;
	size: number;
	mtimeMs: number;
	version: string;
}

async function observe(locate: () => Promise<AppInstall>): Promise<{ app: AppInstall; signature: AppSignature } | null> {
	try {
		const app = await locate();
		const info = await stat(app.asarPath);
		return { app, signature: { asarPath: app.asarPath, size: info.size, mtimeMs: info.mtimeMs, version: app.version } };
	} catch {
		return null;
	}
}

function sameSignature(a: AppSignature | null, b: AppSignature | null): boolean {
	return a?.asarPath === b?.asarPath && a?.size === b?.size && a?.mtimeMs === b?.mtimeMs && a?.version === b?.version;
}

/**
 * Watches the installed Grok Bot: polls `locate` every `intervalMs` and reacts to `fs.watch` events in
 * the asar's directory, comparing `{asarPath, size, mtimeMs, version}`. The first observation is the
 * baseline; a change (including the app appearing after being missing) calls `onChange` once it has
 * stayed the same for `settleMs`, so a half-written update never triggers twice.
 */
export function watchApp(
	locate: () => Promise<AppInstall>,
	onChange: (app: AppInstall) => void,
	intervalMs = 10_000,
	opts: { settleMs?: number; debounceMs?: number; log?: Logger } = {},
): () => void {
	const settleMs = opts.settleMs ?? 1_000;
	const debounceMs = opts.debounceMs ?? 500;
	const log = opts.log ?? nullLogger;
	let baseline: AppSignature | null = null;
	let initialized = false;
	let closed = false;
	let checking = false;
	let again = false;
	let dirWatcher: FSWatcher | null = null;
	let watchedDir: string | null = null;
	let debounce: Timer | undefined;

	const arm = (dir: string | null): void => {
		if (dir === watchedDir) return;
		dirWatcher?.close();
		dirWatcher = null;
		watchedDir = dir;
		if (!dir) return;
		try {
			dirWatcher = watch(dir, { persistent: false }, () => {
				clearTimeout(debounce);
				debounce = setTimeout(() => void check(), debounceMs);
			});
			dirWatcher.on("error", () => {
				dirWatcher?.close();
				dirWatcher = null;
				watchedDir = null;
			});
		} catch (error) {
			log.debug(`app watcher: cannot watch ${dir}: ${errorMessage(error)}`);
			watchedDir = null;
		}
	};

	const check = async (): Promise<void> => {
		if (closed) return;
		if (checking) {
			again = true;
			return;
		}
		checking = true;
		try {
			const first = await observe(locate);
			if (!initialized) {
				initialized = true;
				baseline = first?.signature ?? null;
			} else if (first && !sameSignature(first.signature, baseline)) {
				await Bun.sleep(settleMs);
				const second = closed ? null : await observe(locate);
				if (second && sameSignature(second.signature, first.signature)) {
					baseline = second.signature;
					log.info(`Grok Bot changed: ${second.app.version} at ${second.app.asarPath}`);
					onChange(second.app);
				} else {
					again = true;
				}
			}
			// A missing app (uninstalled, mid-update, lookup hiccup) keeps the baseline: only a different install counts.
			arm(baseline ? path.dirname(baseline.asarPath) : null);
		} finally {
			checking = false;
			if (again && !closed) {
				again = false;
				void check();
			}
		}
	};

	void check();
	const timer = setInterval(() => void check(), intervalMs);
	return () => {
		closed = true;
		clearInterval(timer);
		clearTimeout(debounce);
		dirWatcher?.close();
	};
}

/** What changed under `DATA`: `config.json`, `plugins/`, `themes/`, `dev-plugins.json` (`devList`) or a dev plugin dir (`dev`). */
export type DataChange = "config" | "plugins" | "themes" | "devList" | "dev";

export interface DataWatcher {
	/** Replaces the watched dev plugin dirs. */
	setDevDirs(dirs: readonly string[]): void;
	close(): void;
}

/**
 * Watches the agent's inputs under `DATA` (plus dev plugin dirs) and reports the kinds of change after
 * `debounceMs` of quiet.
 */
export async function watchData(
	paths: DataPaths,
	onChange: (changes: ReadonlySet<DataChange>) => void,
	opts: { debounceMs?: number; devDirs?: readonly string[]; log?: Logger } = {},
): Promise<DataWatcher> {
	const debounceMs = opts.debounceMs ?? 500;
	const log = opts.log ?? nullLogger;
	const pending = new Set<DataChange>();
	let timer: Timer | undefined;
	let closed = false;

	const report = (change: DataChange): void => {
		if (closed) return;
		pending.add(change);
		clearTimeout(timer);
		timer = setTimeout(() => {
			const changes = new Set(pending);
			pending.clear();
			onChange(changes);
		}, debounceMs);
	};

	const open = (target: string, recursive: boolean, listener: (file: string | null) => void): FSWatcher | null => {
		try {
			const watcher = watch(target, { persistent: false, recursive }, (_event, file) => listener(file));
			watcher.on("error", (error) => log.warn(`watcher on ${target}: ${errorMessage(error)}`));
			return watcher;
		} catch (error) {
			if (recursive) return open(target, false, listener);
			log.warn(`cannot watch ${target}: ${errorMessage(error)}`);
			return null;
		}
	};

	await mkdir(paths.plugins, { recursive: true });
	await mkdir(paths.themes, { recursive: true });
	const configName = path.basename(paths.config);
	const devListName = path.basename(paths.devPlugins);
	const fixed = [
		// `config.json` is replaced by rename, so watch its directory rather than the file.
		open(paths.root, false, (file) => {
			if (file === null || file.startsWith(configName)) report("config");
			if (file === null || file.startsWith(devListName)) report("devList");
		}),
		open(paths.plugins, true, () => report("plugins")),
		open(paths.themes, true, () => report("themes")),
	];
	let devWatchers: (FSWatcher | null)[] = [];
	const setDevDirs = (dirs: readonly string[]): void => {
		for (const watcher of devWatchers) watcher?.close();
		devWatchers = closed ? [] : dirs.map((dir) => open(dir, true, () => report("dev")));
	};
	setDevDirs(opts.devDirs ?? []);

	return {
		setDevDirs,
		close() {
			closed = true;
			clearTimeout(timer);
			for (const watcher of [...fixed, ...devWatchers]) watcher?.close();
		},
	};
}

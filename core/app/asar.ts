import * as asar from "@electron/asar";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { mutateState, readState } from "../state.ts";
import { readAppPackage } from "./package.ts";

const MAIN_PROCESS_FILE = "dist/electron-main/main-core.cjs";
const RENDERER_DIR = "dist/renderer";

/** The app's asar changed (an update landed) while a build was reading it. */
export class AppChangedError extends Error {
	constructor(message = "Grok Bot changed during the build") {
		super(message);
		this.name = "AppChangedError";
	}
}

/**
 * Runs `fn` after dropping `@electron/asar`'s cached header for `asarPath`, so a long-lived process never
 * reads stale offsets after an app update replaced the asar at the same path. Every `@electron/asar` call
 * in `core/app/` goes through here.
 */
export async function withArchive<T>(asarPath: string, fn: () => T | Promise<T>): Promise<T> {
	asar.uncache(asarPath);
	return await fn();
}

/** Identity of an asar file on disk; any difference means it was replaced or rewritten. */
export interface AsarStamp {
	size: number;
	mtimeMs: number;
	ino: number;
}

export async function asarStamp(asarPath: string): Promise<AsarStamp> {
	const info = await stat(asarPath);
	return { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
}

function sameStamp(a: AsarStamp, b: AsarStamp): boolean {
	return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

async function versionLabel(asarPath: string): Promise<string> {
	try {
		return `Grok Bot ${(await readAppPackage(asarPath)).version}`;
	} catch {
		return `Grok Bot at ${asarPath}`;
	}
}

/** Fails unless the app's main process still honors the `VITE_DEV_SERVER_URL` renderer override. */
export async function checkSupport(_ctx: CoreContext, asarPath: string): Promise<void> {
	let source: string;
	try {
		source = await withArchive(asarPath, () => asar.extractFile(asarPath, MAIN_PROCESS_FILE).toString("utf8"));
	} catch (error) {
		throw new Error(
			`${await versionLabel(asarPath)} is unsupported: cannot read ${MAIN_PROCESS_FILE} from app.asar (${errorMessage(error)}).`,
		);
	}
	if (!source.includes("VITE_DEV_SERVER_URL")) {
		throw new Error(
			`${await versionLabel(asarPath)} no longer supports the renderer override (VITE_DEV_SERVER_URL is gone from ${MAIN_PROCESS_FILE}); Better Grok Bot cannot load plugins into this version.`,
		);
	}
}

type HeaderNode = asar.DirectoryRecord | asar.FileRecord | { link: string };

/**
 * Copies `dist/renderer/**` out of the asar into `dest` (read-only on the app) and returns the
 * renderer-relative POSIX paths written. The asar's `{size, mtimeMs, ino}` is compared before and after
 * (and against `opts.expected`, the stamp the caller fingerprinted); any difference deletes `dest` and
 * throws {@link AppChangedError}.
 */
export async function extractRenderer(
	_ctx: CoreContext,
	asarPath: string,
	dest: string,
	opts: { expected?: AsarStamp } = {},
): Promise<string[]> {
	const before = await asarStamp(asarPath);
	const changed = async (): Promise<AppChangedError> => {
		await rm(dest, { recursive: true, force: true });
		return new AppChangedError();
	};
	if (opts.expected !== undefined && !sameStamp(opts.expected, before)) throw await changed();
	const files: string[] = [];
	try {
		await withArchive(asarPath, async () => {
			let node: HeaderNode | undefined = asar.getRawHeader(asarPath).header;
			for (const segment of RENDERER_DIR.split("/")) {
				node = node !== undefined && "files" in node ? node.files[segment] : undefined;
			}
			if (node === undefined || !("files" in node)) throw new Error(`app.asar has no ${RENDERER_DIR}/ directory`);
			const walk = async (directory: asar.DirectoryRecord, relative: string): Promise<void> => {
				for (const [name, child] of Object.entries(directory.files)) {
					if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
						throw new Error(`app.asar contains an unsafe entry name ${JSON.stringify(name)}`);
					}
					const childRelative = relative === "" ? name : `${relative}/${name}`;
					if ("files" in child) {
						await walk(child, childRelative);
						continue;
					}
					// Links are followed; unpacked files are read from app.asar.unpacked by @electron/asar.
					const contents = asar.extractFile(asarPath, `${RENDERER_DIR}/${childRelative}`);
					const target = path.join(dest, ...childRelative.split("/"));
					await mkdir(path.dirname(target), { recursive: true });
					await writeFile(target, contents);
					files.push(childRelative);
				}
			};
			await walk(node, "");
		});
	} catch (error) {
		if (!sameStamp(before, await asarStamp(asarPath).catch(() => ({ size: -1, mtimeMs: -1, ino: -1 })))) throw await changed();
		throw error;
	}
	if (!sameStamp(before, await asarStamp(asarPath))) throw await changed();
	if (!files.includes("index.html")) throw new Error(`app.asar ${RENDERER_DIR}/ has no index.html`);
	return files;
}

/** sha256 (hex) of the asar file, cached in `state.asarFingerprint` by `{path, size, mtimeMs}`. */
export async function fingerprint(ctx: CoreContext, asarPath: string): Promise<string> {
	const resolved = path.resolve(asarPath);
	const info = await stat(resolved);
	const cached = (await readState(ctx.paths)).asarFingerprint;
	if (cached !== null && cached.path === resolved && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
		return cached.sha256;
	}
	const hasher = new Bun.CryptoHasher("sha256");
	const reader = Bun.file(resolved).stream().getReader();
	for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) hasher.update(chunk.value);
	const sha256 = hasher.digest("hex");
	await mutateState(ctx.paths, (state) => {
		state.asarFingerprint = { path: resolved, size: info.size, mtimeMs: info.mtimeMs, sha256 };
	});
	return sha256;
}

import { inflateSync, zipSync } from "fflate";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { BgbError } from "../errors.ts";

const MiB = 1024 * 1024;

/** Limits shared by `.bgbplugin` zips and directory package sources. */
export const PACKAGE_LIMITS = Object.freeze({
	maxEntries: 2_000,
	maxEntryBytes: 20 * MiB,
	maxTotalBytes: 50 * MiB,
	maxPathLength: 255,
	maxPathSegments: 16,
});

/** Install record kept in each community plugin dir. */
export const SOURCE_RECORD = ".bgb-source.json";

/** Names never taken from a directory source or counted in a package tree hash. */
const IGNORED_NAMES: Record<string, true> = { ".DS_Store": true, node_modules: true, ".git": true };

/** Code-unit order (locale independent), so tree hashes and zips are identical on every machine. */
export function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function invalid(message: string): BgbError {
	return new BgbError("bad-request", `invalid package: ${message}`);
}

/** The problem with a package entry path, or `undefined` when it is a safe relative POSIX path. */
export function entryPathProblem(name: string): string | undefined {
	if (name === "") return "an entry has an empty path";
	if (name.length > PACKAGE_LIMITS.maxPathLength) return `entry path longer than ${PACKAGE_LIMITS.maxPathLength} characters: ${name.slice(0, 64)}…`;
	if (name.includes("\0")) return `entry path contains a NUL character: ${JSON.stringify(name)}`;
	if (name.includes("\\")) return `entry path contains a backslash: ${name}`;
	if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return `entry path is absolute: ${name}`;
	const segments = name.split("/");
	if (segments.length > PACKAGE_LIMITS.maxPathSegments) return `entry path deeper than ${PACKAGE_LIMITS.maxPathSegments} segments: ${name}`;
	if (segments.some((segment) => segment === "..")) return `entry path contains "..": ${name}`;
	if (segments.some((segment) => segment === "" || segment === ".")) return `entry path has an empty or "." segment: ${name}`;
	return undefined;
}

interface CentralEntry {
	name: string;
	method: number;
	compressedSize: number;
	size: number;
	localOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function readCentralDirectory(bytes: Uint8Array): CentralEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let eocd = -1;
	for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
		if (view.getUint32(at, true) === EOCD_SIGNATURE) {
			eocd = at;
			break;
		}
	}
	if (eocd === -1) throw invalid("not a zip archive");
	const entryCount = view.getUint16(eocd + 10, true);
	const centralOffset = view.getUint32(eocd + 16, true);
	if (entryCount === 0xffff || centralOffset === 0xffffffff) throw invalid("zip64 archives are not supported");
	if (entryCount > PACKAGE_LIMITS.maxEntries) throw invalid(`more than ${PACKAGE_LIMITS.maxEntries} entries`);

	const entries: CentralEntry[] = [];
	const seen = new Set<string>();
	let declaredTotal = 0;
	let at = centralOffset;
	for (let index = 0; index < entryCount; index++) {
		if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw invalid("corrupt central directory");
		const madeBy = view.getUint16(at + 4, true);
		const flags = view.getUint16(at + 8, true);
		const method = view.getUint16(at + 10, true);
		const compressedSize = view.getUint32(at + 20, true);
		const size = view.getUint32(at + 24, true);
		const nameLength = view.getUint16(at + 28, true);
		const extraLength = view.getUint16(at + 30, true);
		const commentLength = view.getUint16(at + 32, true);
		const externalAttributes = view.getUint32(at + 38, true);
		const localOffset = view.getUint32(at + 42, true);
		if (at + 46 + nameLength > bytes.length) throw invalid("corrupt central directory");
		let name: string;
		const rawName = bytes.subarray(at + 46, at + 46 + nameLength);
		try {
			name =
				(flags & 0x800) !== 0
					? new TextDecoder("utf-8", { fatal: true }).decode(rawName)
					: Array.from(rawName, (byte) => String.fromCharCode(byte)).join("");
		} catch {
			throw invalid("an entry name is not valid UTF-8");
		}
		at += 46 + nameLength + extraLength + commentLength;

		const isDirectory = name.endsWith("/");
		const problem = entryPathProblem(isDirectory ? name.slice(0, -1) : name);
		if (problem !== undefined) throw invalid(problem);
		if (madeBy >> 8 === 3 && ((externalAttributes >>> 16) & S_IFMT) === S_IFLNK) throw invalid(`entry is a symlink: ${name}`);
		if ((flags & 0x1) !== 0) throw invalid(`entry is encrypted: ${name}`);
		if (seen.has(name)) throw invalid(`duplicate entry: ${name}`);
		seen.add(name);
		if (isDirectory) continue;
		if (method !== 0 && method !== 8) throw invalid(`entry uses unsupported compression method ${method}: ${name}`);
		if (size === 0xffffffff || compressedSize === 0xffffffff) throw invalid("zip64 archives are not supported");
		if (size > PACKAGE_LIMITS.maxEntryBytes) throw invalid(`entry larger than 20 MiB: ${name}`);
		declaredTotal += size;
		if (declaredTotal > PACKAGE_LIMITS.maxTotalBytes) throw invalid("more than 50 MiB in total");
		entries.push({ name, method, compressedSize, size, localOffset });
	}
	return entries;
}

/**
 * Reads a `.bgbplugin` zip into memory. Rejects `..`/absolute/backslash paths, symlinks, encrypted or
 * zip64 entries, more than 2,000 entries, any entry over 20 MiB and more than 50 MiB in total. Sizes are
 * checked as declared before inflating and as actually inflated afterwards.
 */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const files = new Map<string, Uint8Array>();
	for (const entry of readCentralDirectory(bytes)) {
		const at = entry.localOffset;
		if (at + 30 > bytes.length || view.getUint32(at, true) !== LOCAL_SIGNATURE) throw invalid(`corrupt local header: ${entry.name}`);
		const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
		const end = start + entry.compressedSize;
		if (end > bytes.length) throw invalid(`truncated entry: ${entry.name}`);
		const data = bytes.subarray(start, end);
		let content: Uint8Array;
		if (entry.method === 0) {
			if (data.length !== entry.size) throw invalid(`stored entry size differs from its declared size: ${entry.name}`);
			content = data.slice();
		} else {
			// One spare byte: an entry that inflates past its declared size fills it (writes beyond are dropped).
			let inflated: Uint8Array;
			try {
				inflated = inflateSync(data, { out: new Uint8Array(entry.size + 1) });
			} catch {
				throw invalid(`entry inflates beyond its declared size or is corrupt: ${entry.name}`);
			}
			if (inflated.length > entry.size) throw invalid(`entry inflates beyond its declared size: ${entry.name}`);
			if (inflated.length !== entry.size) throw invalid(`entry inflates to less than its declared size: ${entry.name}`);
			content = inflated.slice();
		}
		files.set(entry.name, content);
	}
	return files;
}

/** Zips `files` deterministically (sorted names, fixed timestamps). */
export function writeZip(files: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>): Uint8Array {
	const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
	const zippable: Record<string, Uint8Array> = {};
	for (const [name, content] of entries.sort(([a], [b]) => compareNames(a, b))) {
		const problem = entryPathProblem(name);
		if (problem !== undefined) throw invalid(problem);
		zippable[name] = content;
	}
	return zipSync(zippable, { level: 9, mtime: new Date("1980-01-02T00:00:00Z") });
}

/**
 * Reads a directory package source into memory with the zip limits: entry count, per-file and total
 * sizes, path length and depth. Symlinks are rejected. Skips `.DS_Store`, `node_modules`, `.git` and the
 * install record `.bgb-source.json`.
 */
export async function readPackageDir(root: string): Promise<Map<string, Uint8Array>> {
	const files = new Map<string, Uint8Array>();
	let total = 0;
	let count = 0;
	const walk = async (relative: string): Promise<void> => {
		const entries = await readdir(path.join(root, relative), { withFileTypes: true });
		for (const entry of entries.sort((a, b) => compareNames(a.name, b.name))) {
			if (IGNORED_NAMES[entry.name] === true || (relative === "" && entry.name === SOURCE_RECORD)) continue;
			const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
			const problem = entryPathProblem(child);
			if (problem !== undefined) throw invalid(problem);
			if (++count > PACKAGE_LIMITS.maxEntries) throw invalid(`more than ${PACKAGE_LIMITS.maxEntries} entries`);
			const full = path.join(root, ...child.split("/"));
			const info = await lstat(full);
			if (info.isSymbolicLink()) throw invalid(`entry is a symlink: ${child}`);
			if (info.isDirectory()) {
				await walk(child);
				continue;
			}
			if (!info.isFile()) throw invalid(`entry is not a regular file: ${child}`);
			if (info.size > PACKAGE_LIMITS.maxEntryBytes) throw invalid(`entry larger than 20 MiB: ${child}`);
			total += info.size;
			if (total > PACKAGE_LIMITS.maxTotalBytes) throw invalid("more than 50 MiB in total");
			files.set(child, new Uint8Array(await readFile(full)));
		}
	};
	await walk("");
	return files;
}

/** Feeds `file <rel>\0<length>\0<bytes>` for each file, in sorted order, into `hasher` (grok-mods tree hashing). */
export function hashFiles(hasher: Bun.CryptoHasher, files: Iterable<readonly [string, Uint8Array]>): void {
	for (const [name, content] of [...files].sort(([a], [b]) => compareNames(a, b))) {
		hasher.update(`file ${name}\0${content.byteLength}\0`);
		hasher.update(content);
	}
}

/** Renderer-style relative POSIX paths of the regular files under `root`, sorted; skips ignored names and `exclude`. */
export async function listTree(root: string, exclude: ReadonlySet<string> = new Set()): Promise<string[]> {
	const files: string[] = [];
	const walk = async (relative: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(path.join(root, relative), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => compareNames(a.name, b.name))) {
			if (IGNORED_NAMES[entry.name] === true) continue;
			const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
			if (exclude.has(child)) continue;
			if (entry.isDirectory()) await walk(child);
			else if (entry.isFile()) files.push(child);
		}
	};
	await walk("");
	return files;
}

/** Hashes the tree under `root` into `hasher` (same format as {@link hashFiles}). */
export async function hashTree(hasher: Bun.CryptoHasher, root: string, exclude: ReadonlySet<string> = new Set()): Promise<void> {
	for (const file of await listTree(root, exclude)) {
		const content = new Uint8Array(await readFile(path.join(root, ...file.split("/"))));
		hasher.update(`file ${file}\0${content.byteLength}\0`);
		hasher.update(content);
	}
}

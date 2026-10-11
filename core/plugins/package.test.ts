import { afterEach, beforeEach, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readPackageDir, readZip, writeZip } from "./package.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Offsets of each central directory header in a zip made by fflate. */
function centralHeaders(zip: Uint8Array): number[] {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let eocd = zip.length - 22;
	while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
	const count = view.getUint16(eocd + 10, true);
	const offsets: number[] = [];
	let at = view.getUint32(eocd + 16, true);
	for (let i = 0; i < count; i++) {
		offsets.push(at);
		at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
	}
	return offsets;
}

/** Rewrites the declared uncompressed size of every entry (central and local headers). */
function declareSize(zip: Uint8Array, size: number): Uint8Array {
	const copy = zip.slice();
	const view = new DataView(copy.buffer);
	for (const at of centralHeaders(copy)) {
		view.setUint32(at + 24, size, true);
		view.setUint32(view.getUint32(at + 42, true) + 22, size, true);
	}
	return copy;
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "bgb-zip-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("writeZip and readZip round-trip deterministically", () => {
	const files = new Map([
		["plugin.json", encode("{}")],
		["assets/a.css", encode("a".repeat(5000))],
	]);
	const zip = writeZip(files);
	expect(writeZip(new Map([...files].reverse()))).toEqual(zip);
	expect(readZip(zip)).toEqual(files);
});

test("readZip rejects more than 2,000 entries", () => {
	const files: Record<string, Uint8Array> = {};
	for (let i = 0; i < 2001; i++) files[`f${i}`] = new Uint8Array(0);
	expect(() => readZip(zipSync(files))).toThrow("more than 2000 entries");
	delete files.f2000;
	expect(readZip(zipSync(files)).size).toBe(2000);
});

test("readZip rejects unsafe paths and symlinks", () => {
	expect(() => readZip(zipSync({ "a/../../evil": encode("x") }))).toThrow('entry path contains ".."');
	expect(() => readZip(zipSync({ "/etc/evil": encode("x") }))).toThrow("entry path is absolute");
	expect(() => readZip(zipSync({ "C:/evil": encode("x") }))).toThrow("entry path is absolute");
	expect(() => readZip(zipSync({ "a\\b": encode("x") }))).toThrow("backslash");
	expect(() => readZip(zipSync({ [`${"d/".repeat(16)}f`]: encode("x") }))).toThrow("deeper than 16 segments");
	expect(() => readZip(zipSync({ ["x".repeat(256)]: encode("x") }))).toThrow("longer than 255 characters");

	const link = zipSync({ link: encode("/etc/passwd") });
	const view = new DataView(link.buffer, link.byteOffset, link.byteLength);
	for (const at of centralHeaders(link)) {
		view.setUint16(at + 4, (3 << 8) | 20, true);
		view.setUint32(at + 38, (0o120777 << 16) >>> 0, true);
	}
	expect(() => readZip(link)).toThrow("entry is a symlink: link");
});

test("readZip checks declared sizes before inflating and actual sizes after", () => {
	const deflated = zipSync({ big: encode("a".repeat(100_000)) }, { level: 9 });
	expect(() => readZip(declareSize(deflated, 10))).toThrow("entry inflates beyond its declared size");
	expect(() => readZip(declareSize(deflated, 200_000))).toThrow("entry inflates to less than its declared size");
	expect(() => readZip(declareSize(deflated, 20 * 1024 * 1024 + 1))).toThrow("entry larger than 20 MiB");
	const stored = zipSync({ s: encode("abc") }, { level: 0 });
	expect(() => readZip(declareSize(stored, 2))).toThrow("stored entry size differs from its declared size");
	const three = declareSize(zipSync({ a: encode("a"), b: encode("b"), c: encode("c") }), 20 * 1024 * 1024);
	expect(() => readZip(three)).toThrow("more than 50 MiB in total");
	expect(() => readZip(encode("not a zip at all, definitely not"))).toThrow("not a zip archive");
});

test("readPackageDir reads a directory source with the zip limits and rejects symlinks", async () => {
	await mkdir(path.join(dir, "pkg", "assets"), { recursive: true });
	await writeFile(path.join(dir, "pkg", "plugin.json"), "{}");
	await writeFile(path.join(dir, "pkg", "assets", "a.css"), "a");
	await writeFile(path.join(dir, "pkg", ".DS_Store"), "junk");
	await writeFile(path.join(dir, "pkg", ".bgb-source.json"), "{}");
	expect([...(await readPackageDir(path.join(dir, "pkg"))).keys()]).toEqual(["assets/a.css", "plugin.json"]);
	await symlink("/etc/hosts", path.join(dir, "pkg", "hosts"));
	await expect(readPackageDir(path.join(dir, "pkg"))).rejects.toThrow("entry is a symlink: hosts");
});

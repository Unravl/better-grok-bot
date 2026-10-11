import * as asar from "@electron/asar";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

export interface FixtureAsarOptions {
	version: string;
	/** `dist/electron-main/main-core.cjs` reads `VITE_DEV_SERVER_URL` (default true). */
	mainHasHook?: boolean;
	/** Files under `dist/renderer/`, keyed by renderer-relative path. */
	renderer: Record<string, string>;
	/** Output path; default `<dir>/app-<random>.asar`. Reusing a path overwrites that asar. */
	asarPath?: string;
	/** Merged over `{name:"sand", productName:"Grok Bot", version, main}`. */
	packageJson?: Record<string, unknown>;
}

/** Packs a minimal Grok Bot-shaped `app.asar` into `dir` and returns its path. */
export async function makeFixtureAsar(dir: string, opts: FixtureAsarOptions): Promise<string> {
	await mkdir(dir, { recursive: true });
	const src = await mkdtemp(path.join(dir, ".fixture-src-"));
	const out = opts.asarPath ?? path.join(dir, `app-${randomBytes(4).toString("hex")}.asar`);
	const files: Record<string, string> = {
		"package.json": JSON.stringify({
			name: "sand",
			productName: "Grok Bot",
			version: opts.version,
			main: "dist/electron-main/main-core.cjs",
			...opts.packageJson,
		}),
		"dist/electron-main/main-core.cjs":
			(opts.mainHasHook ?? true)
				? '"use strict";module.exports=e=>({devServerUrl:e.VITE_DEV_SERVER_URL});\n'
				: '"use strict";module.exports=()=>({devServerUrl:null});\n',
	};
	for (const [rel, text] of Object.entries(opts.renderer)) files[`dist/renderer/${rel}`] = text;
	try {
		for (const [rel, text] of Object.entries(files)) {
			const file = path.join(src, ...rel.split("/"));
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, text);
		}
		await rm(out, { force: true });
		await asar.createPackage(src, out);
		await waitForArchive(out, Object.values(files).reduce((total, text) => total + Buffer.byteLength(text), 0));
	} finally {
		await rm(src, { recursive: true, force: true });
	}
	return out;
}

/**
 * `asar.createPackage` resolves after `end()`-ing its write stream, before the bytes reach the disk
 * (on Windows, reading right away returns a truncated archive). Waits until the file holds the 8-byte
 * size prefix, the header and every packed byte.
 */
async function waitForArchive(asarPath: string, contentBytes: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		asar.uncache(asarPath);
		try {
			const { headerSize } = asar.getRawHeader(asarPath);
			if ((await stat(asarPath)).size === 8 + headerSize + contentBytes) break;
		} catch {
			// The header is not fully written yet.
		}
		if (Date.now() >= deadline) throw new Error(`${asarPath} was not completely written within 10 s`);
		await Bun.sleep(5);
	}
	asar.uncache(asarPath);
}

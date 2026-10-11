import * as asar from "@electron/asar";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
		asar.uncache(out);
	} finally {
		await rm(src, { recursive: true, force: true });
	}
	return out;
}

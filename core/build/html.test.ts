import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { injectScripts, pinResources } from "./html.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "bgb-html-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("injectScripts puts boot.js then plugin runtimes before the first script, keeping indentation", () => {
	const html = "<head>\n    <meta charset=utf-8>\n    <script src=\"./assets/app.js\"></script>\n</head>";
	expect(injectScripts(html, ["one", "two"])).toBe(
		'<head>\n    <meta charset=utf-8>\n    <script src="./assets/bgb/boot.js"></script>\n    <script src="./assets/bgb/plugins/one.js" data-bgb-plugin="one"></script>\n    <script src="./assets/bgb/plugins/two.js" data-bgb-plugin="two"></script>\n    <script src="./assets/app.js"></script>\n</head>',
	);
	expect(() => injectScripts("<html></html>", [])).toThrow("no <script> tag");
});

test("pinResources rewrites relative src/href to file: URLs in the final dir and leaves the rest", async () => {
	const staging = path.join(dir, "staging");
	const final = path.join(dir, "final dir", "renderer");
	for (const file of ["assets/app.js", "assets/font.woff2", "assets/x.css"]) {
		await mkdir(path.dirname(path.join(staging, file)), { recursive: true });
		await writeFile(path.join(staging, file), "");
	}
	const html = [
		'<script src="./assets/app.js"></script>',
		"<link rel=preload href=assets/font.woff2?v=1#f>",
		"<link rel='stylesheet' href='../renderer/assets/x.css'>",
		'<a href="#top"></a><img src="data:image/png;base64,AA"><a href="https://x.ai/">',
		'<img src="/abs.png"><use href="#icon"></use>',
		'<script>const s = document.createElement("script"); s.src = "./missing.js";</script>',
		'<!-- <script src="./missing.js"></script> -->',
		'<meta content="default-src \'self\'; script-src \'self\'">',
	].join("\n");
	const pinned = await pinResources(html, "index.html", staging, final);
	const base = pathToFileURL(path.join(final, "index.html"));
	expect(pinned).toContain(`<script src="${new URL("assets/app.js", base).href}"></script>`);
	expect(pinned).toContain(`href="${new URL("assets/font.woff2?v=1#f", base).href}"`);
	expect(pinned).toContain(`href="${new URL("assets/x.css", base).href}"`);
	expect(new URL("assets/app.js", base).href).toContain("final%20dir");
	expect(pinned).toContain('<a href="#top"></a><img src="data:image/png;base64,AA"><a href="https://x.ai/">');
	expect(pinned).toContain('<img src="/abs.png"><use href="#icon"></use>');
	expect(pinned).toContain('s.src = "./missing.js";</script>');
	expect(pinned).toContain('<!-- <script src="./missing.js"></script> -->');
});

test("pinResources resolves nested HTML against its own location and fails on a missing target", async () => {
	const staging = path.join(dir, "staging");
	const final = path.join(dir, "final");
	await mkdir(path.join(staging, "assets"), { recursive: true });
	await writeFile(path.join(staging, "assets", "panel.js"), "");
	const panel = '<script type="module" src="../../assets/panel.js"></script>';
	const pinned = await pinResources(panel, "src/panel/panel.html", staging, final);
	expect(pinned).toBe(`<script type="module" src="${pathToFileURL(path.join(final, "assets", "panel.js")).href}"></script>`);

	await expect(pinResources('<script src="./assets/gone.js"></script>', "index.html", staging, final)).rejects.toThrow(
		"unresolved renderer reference ./assets/gone.js in index.html",
	);
	await expect(pinResources('<link href="../outside.css">', "index.html", staging, final)).rejects.toThrow(
		"unresolved renderer reference ../outside.css in index.html",
	);
});

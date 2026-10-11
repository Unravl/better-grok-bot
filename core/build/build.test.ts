import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BootPayload, PluginPackageJson } from "../../sdk/index.ts";
import { mutateConfig, readConfig } from "../config.ts";
import { BUNDLED_PLUGINS } from "../plugins/bundled.ts";
import { installPlugin } from "../plugins/install.ts";
import { compareNames } from "../plugins/package.ts";
import { readState } from "../state.ts";
import { type TestContext, makeTestContext } from "../test/build-context.ts";
import { makeFixtureAsar } from "../test/fixtures.ts";
import { build, buildDirName, readBuildManifest, readCurrentManifest } from "./index.ts";

let t: TestContext;

beforeEach(async () => {
	t = await makeTestContext();
});

afterEach(async () => {
	await t.cleanup();
});

function renderer(tag: string): Record<string, string> {
	return {
		"index.html": [
			"<!doctype html>",
			"<html><head>",
			`  <script src="./assets/trace-${tag}.js"></script>`,
			`  <script type="module" crossorigin src="./assets/index-${tag}.js"></script>`,
			`  <link rel="modulepreload" crossorigin href="./assets/chunk-${tag}.js">`,
			`  <link rel="stylesheet" crossorigin href="./assets/index-${tag}.css">`,
			"</head><body><div id=root></div></body></html>",
		].join("\n"),
		"src/electron-renderer/desktop-mount/panel/panel.html": `<script type="module" src="../../../../assets/panel-${tag}.js"></script>`,
		[`assets/trace-${tag}.js`]: "",
		[`assets/index-${tag}.js`]: `import "./chunk-${tag}.js";`,
		[`assets/chunk-${tag}.js`]: "export const app = 'ORIGINAL';",
		[`assets/index-${tag}.css`]: "",
		[`assets/panel-${tag}.js`]: "",
	};
}

async function useApp(version: string, files: Record<string, string>): Promise<string> {
	const asarPath = await makeFixtureAsar(t.dir, { version, renderer: files });
	await mutateConfig(t.ctx.paths, (config) => {
		config.appPath = asarPath;
	});
	return asarPath;
}

async function writeTheme(id: string, css: string): Promise<void> {
	await mkdir(t.ctx.paths.themes, { recursive: true });
	await writeFile(path.join(t.ctx.paths.themes, `${id}.theme.css`), css);
}

async function writePackage(dir: string, json: Partial<PluginPackageJson>, assets: { runtime?: string; styles?: string } = {}): Promise<string> {
	await mkdir(dir, { recursive: true });
	const full: PluginPackageJson = {
		format: 1,
		id: "demo",
		name: "Demo",
		description: "A demo",
		version: "1.0.0",
		authors: ["me"],
		apiVersion: 1,
		permissions: [],
		settings: {},
		patches: [],
		runtime: assets.runtime === undefined ? null : "runtime.js",
		styles: assets.styles === undefined ? null : "styles.css",
		...json,
	};
	await writeFile(path.join(dir, "plugin.json"), JSON.stringify(full));
	if (assets.runtime !== undefined) await writeFile(path.join(dir, "runtime.js"), assets.runtime);
	if (assets.styles !== undefined) await writeFile(path.join(dir, "styles.css"), assets.styles);
	return dir;
}

function bootOf(js: string): BootPayload {
	return JSON.parse(js.slice(js.indexOf("=") + 1, js.indexOf(";\n"))) as BootPayload;
}

function srcUrls(html: string): string[] {
	return [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? "");
}

test("A, then B, then A again: the third build is cached and current points at A", async () => {
	const asarA = await useApp("0.68.1", renderer("AAA"));
	const a = await build(t.ctx);
	expect(a.cached).toBe(false);
	expect(path.basename(a.dir)).toBe(buildDirName("0.68.1", a.key));

	await useApp("0.69.0", renderer("BBB"));
	const b = await build(t.ctx);
	expect(b.key).not.toBe(a.key);
	expect(await realpath(t.ctx.paths.current)).toBe(await realpath(b.dir));
	expect((await readCurrentManifest(t.ctx))?.buildKey).toBe(b.key);

	await mutateConfig(t.ctx.paths, (config) => {
		config.appPath = asarA;
	});
	const again = await build(t.ctx);
	expect(again.cached).toBe(true);
	expect(again.key).toBe(a.key);
	expect(again.dir).toBe(a.dir);
	expect(await realpath(t.ctx.paths.current)).toBe(await realpath(a.dir));
	expect((await readState(t.ctx.paths)).lastBuild?.key).toBe(a.key);
	expect((await readBuildManifest(t.ctx, b.key, "0.69.0"))?.appVersion).toBe("0.69.0");
});

test("force rebuilds the same key into a fresh directory", async () => {
	await useApp("0.68.1", renderer("AAA"));
	const first = await build(t.ctx);
	await writeFile(path.join(first.dir, "marker"), "old");
	const forced = await build(t.ctx, { force: true });
	expect(forced.cached).toBe(false);
	expect(forced.key).toBe(first.key);
	expect(forced.dir).toBe(first.dir);
	expect(existsSync(path.join(forced.dir, "marker"))).toBe(false);
	expect(existsSync(path.join(forced.dir, "renderer", "index.html"))).toBe(true);
	expect((await readdir(t.ctx.paths.builds)).filter((name) => name.startsWith("."))).toEqual([]);
});

test("HTML entries pin every relative reference to their own build, so A keeps loading with current on B", async () => {
	await useApp("0.68.1", renderer("AAA"));
	const a = await build(t.ctx);
	await useApp("0.69.0", renderer("BBB"));
	const b = await build(t.ctx);
	expect(await realpath(t.ctx.paths.current)).toBe(await realpath(b.dir));

	for (const entry of ["index.html", "src/electron-renderer/desktop-mount/panel/panel.html"]) {
		const html = await readFile(path.join(a.dir, "renderer", ...entry.split("/")), "utf8");
		const urls = srcUrls(html);
		expect(urls.length).toBeGreaterThan(0);
		for (const url of urls) {
			expect(url.startsWith("file:")).toBe(true);
			const file = fileURLToPath(url);
			expect(file.startsWith(path.join(a.dir, "renderer") + path.sep)).toBe(true);
			expect(existsSync(file)).toBe(true);
		}
	}
	const indexA = await readFile(path.join(a.dir, "renderer", "index.html"), "utf8");
	expect(indexA).toContain("chunk-AAA.js");
	expect(existsSync(path.join(b.dir, "renderer", "assets", "chunk-AAA.js"))).toBe(false);
	expect(indexA.indexOf("assets/bgb/boot.js")).toBeLessThan(indexA.indexOf("trace-AAA.js"));
});

test("an HTML reference to a missing file fails the build", async () => {
	const files = renderer("AAA");
	files["index.html"] = '<script src="./assets/missing.js"></script>';
	await useApp("0.68.1", files);
	await expect(build(t.ctx)).rejects.toThrow("unresolved renderer reference ./assets/missing.js in index.html");
	expect((await readdir(t.ctx.paths.builds)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
});

test("an app version that would place the build outside DATA/builds fails before anything is written", async () => {
	await useApp("../../escaped", renderer("AAA"));
	await expect(build(t.ctx)).rejects.toThrow("has an invalid version");
	expect((await readdir(t.dir)).filter((name) => name.startsWith("escaped"))).toEqual([]);
	expect(existsSync(t.ctx.paths.builds) ? await readdir(t.ctx.paths.builds) : []).toEqual([]);
	expect(existsSync(t.ctx.paths.current)).toBe(false);
});

test("community plugins are patched, injected and listed with every other plugin", async () => {
	await useApp("0.68.1", renderer("AAA"));
	const pkg = await writePackage(
		path.join(t.dir, "src-demo"),
		{
			permissions: ["keys", "media"],
			patches: [{ id: "app", file: { source: "^assets/chunk-", flags: "" }, find: { source: "ORIGINAL", flags: "" }, replace: "PATCHED", expect: 1 }],
		},
		{ runtime: "console.log('demo')", styles: ".demo{}" },
	);
	await installPlugin(t.ctx, pkg, { acceptPermissions: ["keys", "media"] });
	await writePackage(path.join(t.dir, "src-off"), { id: "off", name: "Off" });
	await installPlugin(t.ctx, path.join(t.dir, "src-off"), { acceptPermissions: [] });
	await mkdir(path.join(t.ctx.paths.plugins, "broken"), { recursive: true });
	await writeFile(path.join(t.ctx.paths.plugins, "broken", "plugin.json"), "{}");
	await writePackage(path.join(t.ctx.paths.plugins, "macos-only"), { id: "macos-only", platforms: [t.ctx.platform.id === "darwin" ? "linux" : "darwin"] });
	await writeTheme("dark", "/** @name Dark */ body{color:white}");
	await writeTheme("off", "/** @name Off */ body{color:red}");
	await mutateConfig(t.ctx.paths, (config) => {
		config.disabledPlugins = ["off"];
		config.enabledThemes = ["dark"];
		// A grant later narrowed (e.g. by hand): the build holds grants ∩ declared.
		config.grants.demo = ["keys"];
	});

	const outcome = await build(t.ctx);
	const rendererDir = path.join(outcome.dir, "renderer");
	expect(await readFile(path.join(rendererDir, "assets", "chunk-AAA.js"), "utf8")).toBe("export const app = 'PATCHED';");
	expect(await readFile(path.join(rendererDir, "assets", "bgb", "plugins", "demo.js"), "utf8")).toBe("console.log('demo')");
	const index = await readFile(path.join(rendererDir, "index.html"), "utf8");
	expect(index).toMatch(/<script src="file:[^"]+\/assets\/bgb\/plugins\/demo\.js" data-bgb-plugin="demo"><\/script>/);
	// Plugins that failed to patch get no runtime script.
	expect([...index.matchAll(/data-bgb-plugin="([^"]+)"/g)].map((match) => match[1])).toEqual(["demo"]);

	// The synthetic renderer has none of the app's anchors, so core hooks and bundled plugins with patches fail.
	const bundled = BUNDLED_PLUGINS.map((plugin) => plugin.definition).sort((a, b) => compareNames(a.id, b.id));
	expect(outcome.manifest.plugins.map((plugin) => [plugin.id, plugin.source, plugin.state])).toEqual([
		["bgb-react", "core", "patch-failed"],
		["bgb-settings", "core", "patch-failed"],
		["bgb-client", "core", "patch-failed"],
		["bgb-brand", "core", "patch-failed"],
		...bundled.map((def) => [def.id, "bundled", (def.patches ?? []).length > 0 ? "patch-failed" : "active"]),
		["broken", "community", "invalid"],
		["demo", "community", "active"],
		["macos-only", "community", "unsupported-platform"],
		["off", "community", "disabled"],
	]);
	const demo = outcome.manifest.plugins.find((plugin) => plugin.id === "demo");
	expect(demo).toMatchObject({ source: "community", granted: ["keys"], permissions: ["keys", "media"], hasRuntime: true });

	const boot = bootOf(await readFile(path.join(rendererDir, "assets", "bgb", "boot.js"), "utf8"));
	const config = await readConfig(t.ctx.paths);
	expect(boot.bridge).toEqual({ port: config.bridgePort, token: config.bridgeToken });
	expect(boot.manifest.buildKey).toBe(outcome.key);
	expect(boot.styles).toEqual([
		{ id: "demo", kind: "plugin", css: ".demo{}" },
		{ id: "dark", kind: "theme", css: "/** @name Dark */ body{color:white}" },
	]);
	expect(boot.manifest.themes.map((theme) => [theme.id, theme.enabled])).toEqual([
		["dark", true],
		["off", false],
	]);
});

test("the build key changes with every input that shapes the output, and only then", async () => {
	await useApp("0.68.1", renderer("AAA"));
	const pkg = await writePackage(path.join(t.dir, "src-demo"), { permissions: ["keys"] });
	await installPlugin(t.ctx, pkg, { acceptPermissions: ["keys"] });
	await writeTheme("idle", "/** @name Idle */ a{}");
	const keys = new Set<string>();
	const keyAfter = async (change: () => Promise<unknown>): Promise<string> => {
		await change();
		const outcome = await build(t.ctx);
		expect(keys.has(outcome.key)).toBe(false);
		keys.add(outcome.key);
		return outcome.key;
	};
	const base = await keyAfter(async () => undefined);
	const unchanged = await build(t.ctx);
	expect(unchanged.key).toBe(base);
	expect(unchanged.cached).toBe(true);

	await keyAfter(() => writeTheme("idle", "/** @name Idle */ b{}"));
	await keyAfter(() => mutateConfig(t.ctx.paths, (config) => void (config.enabledThemes = ["idle"])));
	await keyAfter(() => mutateConfig(t.ctx.paths, (config) => void (config.grants = { demo: [] })));
	await keyAfter(() => mutateConfig(t.ctx.paths, (config) => void (config.bridgePort = 40000)));
	await keyAfter(() => mutateConfig(t.ctx.paths, (config) => void (config.bridgeToken = "another-token")));
	await keyAfter(() => mutateConfig(t.ctx.paths, (config) => void (config.disabledPlugins = ["demo"])));
	await keyAfter(() => writePackage(path.join(t.ctx.paths.plugins, "demo"), { permissions: ["keys"], version: "1.0.1" }));
	const last = await build(t.ctx);
	expect(last.cached).toBe(true);
});

test("pruning keeps the three newest builds plus protected keys and current", async () => {
	await useApp("0.68.1", renderer("AAA"));
	const built: string[] = [];
	for (let i = 0; i < 5; i++) {
		await writeTheme("t", `/** @name T */ .v${i}{}`);
		const outcome = await build(t.ctx, { protect: built.length > 0 ? [built[0] ?? ""] : [] });
		built.push(outcome.key);
		// Pin each build's age (oldest first) so pruning order does not depend on clock resolution.
		const age = new Date(Date.now() - (10 - i) * 60_000);
		await utimes(outcome.dir, age, age);
	}
	const remaining = (await readdir(t.ctx.paths.builds)).sort();
	const expected = [built[0], built[2], built[3], built[4]].map((key) => buildDirName("0.68.1", key ?? "")).sort();
	expect(remaining).toEqual(expected);
});

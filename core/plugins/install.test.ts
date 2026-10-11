import { type Mock, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { PluginPackageJson } from "../../sdk/index.ts";
import { mutateConfig, readConfig } from "../config.ts";
import { BgbError } from "../errors.ts";
import { readJsonFile, writeJsonAtomic } from "../json-file.ts";
import { type TestContext, makeTestContext } from "../test/build-context.ts";
import { inspectSource, installInspected, installPlugin, parseSource, uninstallPlugin, updatePlugin } from "./install.ts";
import { writeZip } from "./package.ts";

let t: TestContext;
let fetchSpy: Mock<typeof fetch> | undefined;

beforeEach(async () => {
	t = await makeTestContext();
});

afterEach(async () => {
	fetchSpy?.mockRestore();
	fetchSpy = undefined;
	await t.cleanup();
});

function packageJson(overrides: Partial<PluginPackageJson> = {}): PluginPackageJson {
	return {
		format: 1,
		id: "demo",
		name: "Demo",
		description: "",
		version: "1.0.0",
		authors: [],
		apiVersion: 1,
		permissions: [],
		settings: {},
		patches: [],
		runtime: null,
		styles: null,
		...overrides,
	};
}

function zipOf(json: PluginPackageJson, extra: Record<string, string> = {}): Uint8Array {
	const files = new Map<string, Uint8Array>([["plugin.json", new TextEncoder().encode(JSON.stringify(json))]]);
	for (const [name, text] of Object.entries(extra)) files.set(name, new TextEncoder().encode(text));
	return writeZip(files);
}

async function packageDir(name: string, json: PluginPackageJson): Promise<string> {
	const dir = path.join(t.dir, name);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "plugin.json"), JSON.stringify(json));
	return dir;
}

/** Serves `routes` (URL → bytes or JSON) through a `fetch` spy; anything else is a 404. */
function serve(routes: Record<string, Uint8Array | object | (() => Uint8Array)>): void {
	fetchSpy?.mockRestore();
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const route = routes[url];
		if (route === undefined) return new Response("missing", { status: 404 });
		const body = typeof route === "function" ? route() : route instanceof Uint8Array ? route : JSON.stringify(route);
		return new Response(body, { status: 200 });
	}) as typeof fetch);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(BgbError);
		return (error as BgbError).code;
	}
	throw new Error("expected a BgbError");
}

test("parseSource classifies directories, package files, https URLs and github: sources", async () => {
	const dir = await packageDir("pkg", packageJson());
	const file = path.join(t.dir, "demo-1.0.0.bgbplugin");
	await writeFile(file, zipOf(packageJson()));
	expect(parseSource(dir)).toEqual({ kind: "dir", path: dir });
	expect(parseSource(file)).toEqual({ kind: "file", path: file });
	expect(parseSource("https://example.com/p.bgbplugin")).toEqual({ kind: "url", url: "https://example.com/p.bgbplugin" });
	expect(parseSource("github:owner/repo")).toEqual({ kind: "github", owner: "owner", repo: "repo", tag: null });
	expect(parseSource("github:owner/repo@v1.2")).toEqual({ kind: "github", owner: "owner", repo: "repo", tag: "v1.2" });
	expect(() => parseSource("http://example.com/p.zip")).toThrow("only https:// URLs");
	expect(() => parseSource("github:owner")).toThrow("expected github:owner/repo");
	expect(() => parseSource(path.join(t.dir, "nope"))).toThrow("does not exist");
	expect(() => parseSource(t.dir)).toThrow("has no plugin.json");
});

test("installs from a directory, enabled, with its grant and install record", async () => {
	const dir = await packageDir("pkg", packageJson({ permissions: ["keys"] }));
	expect(await installPlugin(t.ctx, dir, { acceptPermissions: ["keys"] })).toEqual({ id: "demo" });
	const installed = path.join(t.ctx.paths.plugins, "demo");
	expect(JSON.parse(await readFile(path.join(installed, "plugin.json"), "utf8")).id).toBe("demo");
	expect(await readJsonFile(path.join(installed, ".bgb-source.json"))).toMatchObject({ source: dir, version: "1.0.0" });
	const config = await readConfig(t.ctx.paths);
	expect(config.grants).toEqual({ demo: ["keys"] });
	expect(config.disabledPlugins).toEqual([]);
	expect(await readdir(path.join(t.ctx.paths.cache, "inspect"))).toEqual([]);
});

test("installs from a .bgbplugin zip", async () => {
	const file = path.join(t.dir, "demo.bgbplugin");
	await writeFile(file, zipOf(packageJson({ runtime: "runtime.js" }), { "runtime.js": "console.log(1)" }));
	const inspection = await inspectSource(t.ctx, file);
	expect(inspection.sha256).toBe(new Bun.CryptoHasher("sha256").update(await readFile(file)).digest("hex"));
	expect(inspection.replaces).toBeNull();
	await installInspected(t.ctx, inspection.inspectionId, { acceptPermissions: [] });
	expect(await readFile(path.join(t.ctx.paths.plugins, "demo", "runtime.js"), "utf8")).toBe("console.log(1)");
});

test("installs the single .bgbplugin asset of a GitHub release", async () => {
	serve({
		"https://api.github.com/repos/owner/repo/releases/latest": {
			assets: [
				{ name: "README.md", browser_download_url: "https://dl.example/readme" },
				{ name: "demo-1.0.0.bgbplugin", browser_download_url: "https://dl.example/demo" },
			],
		},
		"https://dl.example/demo": zipOf(packageJson()),
		"https://api.github.com/repos/owner/two/releases/tags/v2": {
			assets: [
				{ name: "a.bgbplugin", browser_download_url: "https://dl.example/a" },
				{ name: "b.bgbplugin", browser_download_url: "https://dl.example/b" },
			],
		},
	});
	await installPlugin(t.ctx, "github:owner/repo", { acceptPermissions: [] });
	expect(await readJsonFile(path.join(t.ctx.paths.plugins, "demo", ".bgb-source.json"))).toMatchObject({ source: "github:owner/repo" });
	await expect(inspectSource(t.ctx, "github:owner/two@v2")).rejects.toThrow(
		"the v2 release of owner/two needs exactly one .bgbplugin asset; it has: a.bgbplugin, b.bgbplugin",
	);
	expect(await codeOf(inspectSource(t.ctx, "github:owner/missing"))).toBe("not-found");
});

test("installInspected installs the inspected bytes even after the URL serves different ones", async () => {
	let version = "1.0.0";
	serve({ "https://example.com/demo.bgbplugin": () => zipOf(packageJson({ version })) });
	const inspection = await inspectSource(t.ctx, "https://example.com/demo.bgbplugin");
	version = "6.6.6";
	await installInspected(t.ctx, inspection.inspectionId, { acceptPermissions: [] });
	expect(JSON.parse(await readFile(path.join(t.ctx.paths.plugins, "demo", "plugin.json"), "utf8")).version).toBe("1.0.0");
	expect(await codeOf(installInspected(t.ctx, inspection.inspectionId, { acceptPermissions: [] }))).toBe("not-found");
});

test("permissions short of the request are denied and nothing is installed", async () => {
	const dir = await packageDir("pkg", packageJson({ permissions: ["keys", "media"] }));
	const inspection = await inspectSource(t.ctx, dir);
	expect(await codeOf(installInspected(t.ctx, inspection.inspectionId, { acceptPermissions: ["keys"] }))).toBe("permission-denied");
	expect(existsSync(path.join(t.ctx.paths.plugins, "demo"))).toBe(false);
	await installInspected(t.ctx, inspection.inspectionId, { acceptPermissions: ["keys", "media"] });
	expect((await readConfig(t.ctx.paths)).grants.demo).toEqual(["keys", "media"]);
});

test("an inspection expires after 10 minutes", async () => {
	const dir = await packageDir("pkg", packageJson());
	const inspection = await inspectSource(t.ctx, dir);
	const recordFile = path.join(t.ctx.paths.cache, "inspect", inspection.inspectionId, "inspection.json");
	const record = (await readJsonFile(recordFile)) as Record<string, unknown>;
	await writeJsonAtomic(recordFile, { ...record, createdAt: Date.now() - 11 * 60 * 1000 });
	expect(await codeOf(installInspected(t.ctx, inspection.inspectionId, { acceptPermissions: [] }))).toBe("not-found");
	expect(existsSync(path.dirname(recordFile))).toBe(false);
	expect(await codeOf(installInspected(t.ctx, "../../etc", { acceptPermissions: [] }))).toBe("not-found");
});

test("replacing a disabled plugin keeps it disabled; a new id is enabled", async () => {
	await mutateConfig(t.ctx.paths, (config) => void (config.disabledPlugins = ["demo"]));
	await installPlugin(t.ctx, await packageDir("v1", packageJson()), { acceptPermissions: [] });
	expect((await readConfig(t.ctx.paths)).disabledPlugins).toEqual([]);

	await mutateConfig(t.ctx.paths, (config) => void (config.disabledPlugins = ["demo"]));
	const inspection = await inspectSource(t.ctx, await packageDir("v2", packageJson({ version: "2.0.0" })));
	expect(inspection.replaces).toEqual({ version: "1.0.0", granted: [], enabled: false });
	await installInspected(t.ctx, inspection.inspectionId, { acceptPermissions: [] });
	expect((await readConfig(t.ctx.paths)).disabledPlugins).toEqual(["demo"]);
	expect(JSON.parse(await readFile(path.join(t.ctx.paths.plugins, "demo", "plugin.json"), "utf8")).version).toBe("2.0.0");
	expect((await readdir(t.ctx.paths.plugins)).filter((name) => name.startsWith("."))).toEqual([]);
});

test("updatePlugin: current, updated within the grant, needs-consent for new permissions", async () => {
	let json = packageJson({ permissions: ["keys"] });
	serve({ "https://example.com/demo.bgbplugin": () => zipOf(json) });
	await installPlugin(t.ctx, "https://example.com/demo.bgbplugin", { acceptPermissions: ["keys"] });
	await mutateConfig(t.ctx.paths, (config) => void (config.disabledPlugins = ["demo"]));
	expect(await updatePlugin(t.ctx, "demo")).toEqual({ state: "current" });

	json = packageJson({ permissions: ["keys"], version: "1.1.0" });
	expect(await updatePlugin(t.ctx, "demo")).toEqual({ state: "updated", version: "1.1.0" });
	let config = await readConfig(t.ctx.paths);
	expect(config.disabledPlugins).toEqual(["demo"]);
	expect(config.grants.demo).toEqual(["keys"]);

	json = packageJson({ permissions: ["keys", "media"], version: "2.0.0" });
	const result = await updatePlugin(t.ctx, "demo");
	expect(result).toMatchObject({ state: "needs-consent", version: "2.0.0", added: ["media"] });
	expect(JSON.parse(await readFile(path.join(t.ctx.paths.plugins, "demo", "plugin.json"), "utf8")).version).toBe("1.1.0");
	expect((await readConfig(t.ctx.paths)).grants.demo).toEqual(["keys"]);

	if (result.state !== "needs-consent") throw new Error("unreachable");
	await installInspected(t.ctx, result.inspectionId, { acceptPermissions: ["keys", "media"] });
	config = await readConfig(t.ctx.paths);
	expect(config.grants.demo).toEqual(["keys", "media"]);
	expect(config.disabledPlugins).toEqual(["demo"]);
});

test("invalid and reserved packages are rejected and leave no inspection behind", async () => {
	expect(await codeOf(inspectSource(t.ctx, await packageDir("bad", packageJson({ version: "one" }))))).toBe("bad-request");
	expect(await codeOf(inspectSource(t.ctx, await packageDir("core", packageJson({ id: "bgb-react" }))))).toBe("bad-request");
	const noJson = path.join(t.dir, "empty.bgbplugin");
	await writeFile(noJson, writeZip(new Map([["readme.txt", new Uint8Array(1)]])));
	await expect(inspectSource(t.ctx, noJson)).rejects.toThrow("no plugin.json at its root");
	expect(await readdir(path.join(t.ctx.paths.cache, "inspect"))).toEqual([]);
});

test("uninstallPlugin removes a community plugin with its grant and disabled flag", async () => {
	await installPlugin(t.ctx, await packageDir("pkg", packageJson({ permissions: ["media"] })), { acceptPermissions: ["media"] });
	await mutateConfig(t.ctx.paths, (config) => void (config.disabledPlugins = ["demo", "other"]));
	await uninstallPlugin(t.ctx, "demo");
	expect(existsSync(path.join(t.ctx.paths.plugins, "demo"))).toBe(false);
	const config = await readConfig(t.ctx.paths);
	expect(config.grants).toEqual({});
	expect(config.disabledPlugins).toEqual(["other"]);
	expect(await codeOf(uninstallPlugin(t.ctx, "demo"))).toBe("not-found");
	expect(await codeOf(uninstallPlugin(t.ctx, "bgb-settings"))).toBe("bad-request");
	expect(await codeOf(updatePlugin(t.ctx, "bgb-client"))).toBe("bad-request");
});

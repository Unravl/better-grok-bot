import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Permission, PluginPackageJson, PluginState } from "../../sdk/index.ts";
import { mutateConfig, readConfig } from "../config.ts";
import { type TestContext, makeTestContext } from "../test/build-context.ts";
import { newPlugin } from "./author.ts";
import { BUNDLED_PLUGINS } from "./bundled.ts";
import { addDevDir, loadDevPlugins, readDevDirs, removeDevDir } from "./dev.ts";
import { discoverPlugins } from "./discover.ts";
import { compareNames } from "./package.ts";

let t: TestContext;

beforeEach(async () => {
	t = await makeTestContext();
});

afterEach(async () => {
	await t.cleanup();
});

async function community(id: string, overrides: Partial<PluginPackageJson> = {}): Promise<void> {
	const dir = path.join(t.ctx.paths.plugins, id);
	await mkdir(dir, { recursive: true });
	const json: PluginPackageJson = {
		format: 1,
		id,
		name: id,
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
	await writeFile(path.join(dir, "plugin.json"), JSON.stringify(json));
}

async function devPlugin(id: string, version = "0.1.0"): Promise<string> {
	const dir = path.join(t.dir, "dev", id);
	await newPlugin(t.ctx, id, dir);
	const file = path.join(dir, "plugin.ts");
	await writeFile(file, (await readFile(file, "utf8")).replace('version: "0.1.0"', `version: "${version}"`));
	return dir;
}

test("plugins come in apply order with pre-build states and granted permissions", async () => {
	const bundled = BUNDLED_PLUGINS.map((plugin) => plugin.definition).sort((a, b) => compareNames(a.id, b.id));
	const bundledId = bundled[0]?.id;
	if (bundledId === undefined) throw new Error("expected bundled plugins");
	await community("zeta", { permissions: ["keys", "media"] });
	await community("alpha", { platforms: ["win32"] });
	await community("bgb-sneaky");
	await community(bundledId);
	await mkdir(path.join(t.ctx.paths.plugins, ".tmp-123"), { recursive: true });
	await community("mismatch");
	const mismatch = path.join(t.ctx.paths.plugins, "mismatch", "plugin.json");
	await writeFile(mismatch, (await readFile(mismatch, "utf8")).replace('"id":"mismatch"', '"id":"other"'));
	await mutateConfig(t.ctx.paths, (config) => {
		config.disabledPlugins = ["bgb-react", "zeta", bundledId];
		config.grants = { zeta: ["media", "keys"], alpha: ["keys"] };
	});
	const { plugins, warnings } = await discoverPlugins(t.ctx, await readConfig(t.ctx.paths), "darwin");
	expect(warnings).toEqual([]);
	type Row = [string, string, PluginState | "ready", Permission[]];
	const communityRows: Row[] = [
		["alpha", "community", "unsupported-platform", []],
		["bgb-sneaky", "community", "invalid", []],
		["mismatch", "community", "invalid", []],
		[bundledId, "community", "invalid", []],
		["zeta", "community", "disabled", ["media", "keys"]],
	];
	expect(plugins.map((plugin): Row => [plugin.id, plugin.source, plugin.state ?? "ready", plugin.granted])).toEqual([
		["bgb-react", "core", "ready", []],
		["bgb-settings", "core", "ready", []],
		["bgb-client", "core", "ready", []],
		["bgb-brand", "core", "ready", []],
		...bundled.map((def): Row => [
			def.id,
			"bundled",
			def.platforms !== undefined && !def.platforms.includes("darwin") ? "unsupported-platform" : def.id === bundledId ? "disabled" : "ready",
			def.permissions ?? [],
		]),
		...communityRows.sort((a, b) => compareNames(a[0], b[0])),
	]);
	const sneaky = plugins.find((plugin) => plugin.id === "bgb-sneaky");
	expect(sneaky?.errors.join(" ")).toContain("reserved");
	const shadow = plugins.find((plugin) => plugin.id === bundledId && plugin.source === "community");
	expect(shadow?.errors[0]).toBe(`id "${bundledId}" is reserved`);
	expect(plugins.find((plugin) => plugin.id === "mismatch")?.errors).toEqual(['plugin.json id "other" does not match its directory name "mismatch"']);
	expect(plugins[0]?.enabled).toBe(true);

	const linux = await discoverPlugins(t.ctx, await readConfig(t.ctx.paths), "win32");
	expect(linux.plugins.find((plugin) => plugin.id === "alpha")?.state).toBeUndefined();
});

test("dev plugins are built, cached by source tree, ordered last and replace a community plugin of the same id", async () => {
	await community("shared");
	const shared = await devPlugin("shared", "9.9.9");
	const solo = await devPlugin("solo");
	await addDevDir(t.ctx, solo);
	await addDevDir(t.ctx, shared);
	await addDevDir(t.ctx, shared);
	expect(await readDevDirs(t.ctx)).toEqual([solo, shared]);

	const first = await discoverPlugins(t.ctx, await readConfig(t.ctx.paths), "darwin");
	expect(first.warnings).toEqual([`community plugin "shared" is replaced by the dev plugin in ${shared}`]);
	expect(first.plugins.filter((plugin) => plugin.id === "shared")).toHaveLength(1);
	expect(first.plugins.slice(-2).map((plugin) => [plugin.id, plugin.source, plugin.pkg?.version])).toEqual([
		["shared", "dev", "9.9.9"],
		["solo", "dev", "0.1.0"],
	]);
	const marker = path.join(t.ctx.paths.cache, "dev", "solo", ".bgb-dev.json");
	const builtAt = (await stat(marker)).mtimeMs;

	await loadDevPlugins(t.ctx);
	expect((await stat(marker)).mtimeMs).toBe(builtAt);

	const file = path.join(solo, "plugin.ts");
	await writeFile(file, (await readFile(file, "utf8")).replace('version: "0.1.0"', 'version: "0.2.0"'));
	const rebuilt = await loadDevPlugins(t.ctx);
	expect(rebuilt.find((plugin) => plugin.id === "solo")?.contents?.pkg.version).toBe("0.2.0");

	await writeFile(file, "export default {};\n");
	const broken = await loadDevPlugins(t.ctx);
	expect(broken.find((plugin) => plugin.sourceDir === solo)?.errors[0]).toContain(`dev build of ${solo} failed`);

	await removeDevDir(t.ctx, solo);
	expect(await readDevDirs(t.ctx)).toEqual([shared]);
});

test("two dev dirs providing one id: the second is invalid", async () => {
	const one = await devPlugin("same");
	const other = path.join(t.dir, "dev", "copy");
	await newPlugin(t.ctx, "same", other);
	await addDevDir(t.ctx, one);
	await addDevDir(t.ctx, other);
	const plugins = (await discoverPlugins(t.ctx, await readConfig(t.ctx.paths), "darwin")).plugins.slice(-2);
	expect(plugins.map((plugin) => plugin.source)).toEqual(["dev", "dev"]);
	expect(plugins.map((plugin) => [plugin.id, plugin.state ?? "ready"])).toEqual([
		["copy", "invalid"],
		["same", "ready"],
	]);
	expect(plugins[0]?.errors[0]).toContain(`plugin id "same" is already provided by the dev plugin in ${one}`);
});

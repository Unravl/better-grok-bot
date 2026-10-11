import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { BgbError } from "../errors.ts";
import { type TestContext, makeTestContext } from "../test/build-context.ts";
import { buildPluginPackage, newPlugin, writePackage } from "./author.ts";
import { installPlugin } from "./install.ts";
import { readZip } from "./package.ts";

let t: TestContext;

beforeEach(async () => {
	t = await makeTestContext();
});

afterEach(async () => {
	await t.cleanup();
});

test("newPlugin scaffolds a project with the SDK vendored, and refuses bad ids or non-empty dirs", async () => {
	const dir = path.join(t.dir, "hello-world");
	await newPlugin(t.ctx, "hello-world", dir);
	expect((await readdir(dir)).sort()).toEqual(["README.md", "bgb-sdk", "plugin.ts", "runtime.ts", "tsconfig.json"]);
	expect(await readdir(path.join(dir, "bgb-sdk"))).toContain("index.ts");
	expect(JSON.parse(await readFile(path.join(dir, "tsconfig.json"), "utf8")).compilerOptions.paths).toEqual({
		"@better-grok-bot/sdk": ["./bgb-sdk/index.ts"],
	});
	await expect(newPlugin(t.ctx, "hello-world", dir)).rejects.toThrow("already exists and is not empty");
	await expect(newPlugin(t.ctx, "bgb-mine", path.join(t.dir, "x"))).rejects.toThrow('plugin id "bgb-mine" is reserved');
	await expect(newPlugin(t.ctx, "Not_Valid", path.join(t.dir, "y"))).rejects.toThrow("must be lowercase kebab-case");
});

test("buildPluginPackage builds the scaffold into a valid package that installs", async () => {
	const dir = path.join(t.dir, "hello-world");
	await newPlugin(t.ctx, "hello-world", dir);
	const built = await buildPluginPackage(t.ctx, dir);
	expect(built.json).toMatchObject({ format: 1, id: "hello-world", name: "Hello World", version: "0.1.0", runtime: "runtime.js", styles: null });
	expect(built.runtimeJs).toContain('define("hello-world"');
	expect(built.runtimeJs).toContain("sourceMappingURL=data:");
	expect(await readdir(path.join(t.ctx.paths.cache, "author"))).toEqual([]);

	const out = path.join(t.dir, "out", "hello-world-0.1.0.bgbplugin");
	await writePackage(built, out);
	expect([...readZip(new Uint8Array(await readFile(out))).keys()].sort()).toEqual(["plugin.json", "runtime.js"]);
	await installPlugin(t.ctx, out, { acceptPermissions: [] });
	expect(existsSync(path.join(t.ctx.paths.plugins, "hello-world", "runtime.js"))).toBe(true);
});

test("each build evaluates the current plugin.ts and serializes patches without the g flag", async () => {
	const dir = path.join(t.dir, "p");
	await newPlugin(t.ctx, "patcher", dir);
	const source = (version: string) => `import { definePlugin } from "@better-grok-bot/sdk";
export default definePlugin({
	id: "patcher", name: "Patcher", description: "", version: "${version}", apiVersion: 1,
	patches: [{ id: "x", file: /^assets\\/a\\.js$/g, find: /a(\\i)/gi, replace: "b$1", expect: 2 }],
	styles: "styles.css",
});
`;
	await writeFile(path.join(dir, "plugin.ts"), source("1.0.0"));
	await writeFile(path.join(dir, "styles.css"), ".x{}");
	const first = await buildPluginPackage(t.ctx, dir);
	expect(first.json.patches).toEqual([
		{ id: "x", file: { source: "^assets\\/a\\.js$", flags: "" }, find: { source: "a(\\i)", flags: "i" }, replace: "b$1", expect: 2 },
	]);
	expect(first.json.runtime).toBeNull();
	expect(first.stylesCss).toBe(".x{}");
	await writeFile(path.join(dir, "plugin.ts"), source("1.0.1"));
	expect((await buildPluginPackage(t.ctx, dir)).json.version).toBe("1.0.1");
});

test("function replacers and invalid definitions are rejected", async () => {
	const dir = path.join(t.dir, "fn");
	await newPlugin(t.ctx, "fn-plugin", dir);
	await writeFile(
		path.join(dir, "plugin.ts"),
		`import { definePlugin } from "@better-grok-bot/sdk";
export default definePlugin({ id: "fn-plugin", name: "Fn", description: "", version: "1.0.0", apiVersion: 1,
	patches: [{ id: "f", file: /a/, find: /b/, replace: (m) => m.match }] });
`,
	);
	await expect(buildPluginPackage(t.ctx, dir)).rejects.toThrow("community plugins must use string replacements (patch f)");
	await writeFile(path.join(dir, "plugin.ts"), "export default { id: 'fn-plugin' };\n");
	const error = await buildPluginPackage(t.ctx, dir).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(BgbError);
	expect((error as Error).message).toContain("invalid plugin definition");
	await writeFile(path.join(dir, "plugin.ts"), "export default {;\n");
	await expect(buildPluginPackage(t.ctx, dir)).rejects.toThrow("failed to build");
});

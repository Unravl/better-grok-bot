import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { mutateState, readState } from "../state.ts";
import { type TestContext, makeTestContext } from "../test/build-context.ts";
import { makeFixtureAsar } from "../test/fixtures.ts";
import { readAppPackage } from "./package.ts";
import { AppChangedError, asarStamp, checkSupport, extractRenderer, fingerprint } from "./asar.ts";
import { resolveApp } from "./resolve.ts";

let t: TestContext;

beforeEach(async () => {
	t = await makeTestContext();
});

afterEach(async () => {
	await t.cleanup();
});

test("checkSupport accepts an app that reads VITE_DEV_SERVER_URL and explains one that does not", async () => {
	const ok = await makeFixtureAsar(t.dir, { version: "0.68.1", renderer: { "index.html": "x" } });
	await checkSupport(t.ctx, ok);
	const gone = await makeFixtureAsar(t.dir, { version: "0.70.0", mainHasHook: false, renderer: { "index.html": "x" } });
	await expect(checkSupport(t.ctx, gone)).rejects.toThrow(
		"Grok Bot 0.70.0 no longer supports the renderer override (VITE_DEV_SERVER_URL is gone from dist/electron-main/main-core.cjs)",
	);
});

test("extractRenderer copies dist/renderer and returns renderer-relative paths", async () => {
	const asarPath = await makeFixtureAsar(t.dir, {
		version: "0.68.1",
		renderer: { "index.html": "<html>", "assets/a.js": "A", "src/x/panel.html": "P" },
	});
	const dest = path.join(t.dir, "out");
	expect((await extractRenderer(t.ctx, asarPath, dest)).sort()).toEqual(["assets/a.js", "index.html", "src/x/panel.html"]);
	expect(await readFile(path.join(dest, "src", "x", "panel.html"), "utf8")).toBe("P");
});

test("an asar overwritten at the same path is read fresh", async () => {
	const asarPath = path.join(t.dir, "app.asar");
	await makeFixtureAsar(t.dir, { version: "0.68.1", renderer: { "index.html": "first" }, asarPath });
	expect((await readAppPackage(asarPath)).version).toBe("0.68.1");
	await extractRenderer(t.ctx, asarPath, path.join(t.dir, "one"));
	expect(await readFile(path.join(t.dir, "one", "index.html"), "utf8")).toBe("first");

	await makeFixtureAsar(t.dir, {
		version: "0.69.0",
		renderer: { "index.html": "second, long enough to move every header offset", "assets/new.js": "new" },
		asarPath,
	});
	expect((await readAppPackage(asarPath)).version).toBe("0.69.0");
	expect((await extractRenderer(t.ctx, asarPath, path.join(t.dir, "two"))).sort()).toEqual(["assets/new.js", "index.html"]);
	expect(await readFile(path.join(t.dir, "two", "index.html"), "utf8")).toBe("second, long enough to move every header offset");
});

test("extractRenderer throws AppChangedError and removes its output when the asar is not the fingerprinted one", async () => {
	const asarPath = await makeFixtureAsar(t.dir, { version: "0.68.1", renderer: { "index.html": "x" } });
	const stamp = await asarStamp(asarPath);
	const dest = path.join(t.dir, "out");
	await expect(extractRenderer(t.ctx, asarPath, dest, { expected: { ...stamp, size: stamp.size + 1 } })).rejects.toBeInstanceOf(AppChangedError);
	expect(existsSync(dest)).toBe(false);
	await extractRenderer(t.ctx, asarPath, dest, { expected: stamp });
	expect(existsSync(path.join(dest, "index.html"))).toBe(true);
});

test("fingerprint hashes the asar and reuses the cached hash while path, size and mtime match", async () => {
	const asarPath = path.join(t.dir, "app.asar");
	await makeFixtureAsar(t.dir, { version: "0.68.1", renderer: { "index.html": "x" }, asarPath });
	const expected = new Bun.CryptoHasher("sha256").update(await readFile(asarPath)).digest("hex");
	expect(await fingerprint(t.ctx, asarPath)).toBe(expected);
	const info = await stat(asarPath);
	expect((await readState(t.ctx.paths)).asarFingerprint).toEqual({ path: asarPath, size: info.size, mtimeMs: info.mtimeMs, sha256: expected });

	await mutateState(t.ctx.paths, (state) => {
		if (state.asarFingerprint !== null) state.asarFingerprint.sha256 = "cached";
	});
	expect(await fingerprint(t.ctx, asarPath)).toBe("cached");

	await makeFixtureAsar(t.dir, { version: "0.69.0", renderer: { "index.html": "changed content" }, asarPath });
	const changed = await fingerprint(t.ctx, asarPath);
	expect(changed).toBe(new Bun.CryptoHasher("sha256").update(await readFile(asarPath)).digest("hex"));
	expect(changed).not.toBe(expected);
});

test("resolveApp uses an .asar path directly and anything else through the platform adapter", async () => {
	const asarPath = await makeFixtureAsar(t.dir, { version: "0.68.1", renderer: { "index.html": "x" } });
	expect(await resolveApp(t.ctx, asarPath)).toEqual({
		kind: "custom",
		root: path.dirname(asarPath),
		executable: "",
		asarPath,
		version: "0.68.1",
	});
	await expect(resolveApp(t.ctx, null)).rejects.toThrow("Grok Bot not found");
	const located = await makeTestContext({ app: { kind: "mac-bundle", root: "/A", executable: "/A/x", asarPath, version: "0.68.1" } });
	try {
		expect((await resolveApp(located.ctx, "/Applications/Grok Bot.app")).kind).toBe("mac-bundle");
	} finally {
		await located.cleanup();
	}
});

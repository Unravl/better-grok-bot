import { type Mock, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { mutateConfig, readConfig } from "../config.ts";
import { BgbError } from "../errors.ts";
import { type TestContext, makeTestContext } from "../test/build-context.ts";
import { installTheme, listThemes, parseThemeHeader, setThemeEnabled, themeStyles, uninstallTheme } from "./index.ts";

let t: TestContext;
let fetchSpy: Mock<typeof fetch> | undefined;

beforeEach(async () => {
	t = await makeTestContext();
	await mkdir(t.ctx.paths.themes, { recursive: true });
});

afterEach(async () => {
	fetchSpy?.mockRestore();
	fetchSpy = undefined;
	await t.cleanup();
});

async function theme(file: string, css: string): Promise<void> {
	await writeFile(path.join(t.ctx.paths.themes, file), css);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(BgbError);
	return (error as BgbError).code;
}

test("parseThemeHeader reads BetterDiscord-style tags from the leading comment only", () => {
	expect(parseThemeHeader("/**\n * @name Midnight\n * @description Dark and blue\n * @author Ana <ana@example.com>\n * @version 1.2.0\n */\nbody{}")).toEqual({
		name: "Midnight",
		description: "Dark and blue",
		author: "Ana <ana@example.com>",
		version: "1.2.0",
	});
	expect(parseThemeHeader("/** @name E2E */ :root{--bgb-e2e:1}")).toEqual({ name: "E2E" });
	expect(parseThemeHeader("/** @name A @author B */")).toEqual({ name: "A", author: "B" });
	expect(parseThemeHeader("body{} /** @name Late */")).toEqual({});
});

test("listThemes reports valid themes and invalid ones with their error; only enabled valid themes are styled", async () => {
	await theme("good.theme.css", "/** @name Good */ a{}");
	await theme("plain.theme.css", "a{color:red}");
	await theme("huge.theme.css", `/** @name Huge */${"x".repeat(2 * 1024 * 1024)}`);
	await mkdir(path.join(t.ctx.paths.themes, "dir.theme.css"));
	await theme("notes.txt", "ignored");
	await mutateConfig(t.ctx.paths, (config) => void (config.enabledThemes = ["good", "plain", "huge"]));
	const config = await readConfig(t.ctx.paths);
	expect(await listThemes(t.ctx, config)).toEqual([
		{ id: "dir", name: "dir.theme.css", enabled: false, valid: false, error: expect.stringContaining("unreadable: ") },
		{ id: "good", name: "Good", enabled: true, valid: true },
		{ id: "huge", name: "huge.theme.css", enabled: true, valid: false, error: "larger than 2 MB" },
		{ id: "plain", name: "plain.theme.css", enabled: true, valid: false, error: "missing @name header" },
	]);
	expect(await themeStyles(t.ctx, config)).toEqual([{ id: "good", css: "/** @name Good */ a{}" }]);
});

test("setThemeEnabled refuses invalid or unknown themes", async () => {
	await theme("good.theme.css", "/** @name Good */ a{}");
	await theme("plain.theme.css", "a{}");
	await setThemeEnabled(t.ctx, "good", true);
	expect((await readConfig(t.ctx.paths)).enabledThemes).toEqual(["good"]);
	expect(await codeOf(setThemeEnabled(t.ctx, "plain", true))).toBe("bad-request");
	expect(await codeOf(setThemeEnabled(t.ctx, "missing", true))).toBe("not-found");
	await setThemeEnabled(t.ctx, "plain", false);
	await setThemeEnabled(t.ctx, "good", false);
	expect((await readConfig(t.ctx.paths)).enabledThemes).toEqual([]);
});

test("installTheme from a path or an https URL; uninstallTheme removes file and enabled flag", async () => {
	const source = path.join(t.dir, "e2e.theme.css");
	await writeFile(source, "/** @name E2E */ :root{--bgb-e2e:1}");
	expect(await installTheme(t.ctx, source)).toEqual({ id: "e2e", name: "E2E", enabled: false, valid: true });
	expect(existsSync(path.join(t.ctx.paths.themes, "e2e.theme.css"))).toBe(true);

	let body = "/** @name Remote */ b{}";
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input: string | URL | Request) => new Response(body)) as typeof fetch);
	expect((await installTheme(t.ctx, "https://example.com/themes/remote.theme.css")).id).toBe("remote");
	body = "b{}";
	expect(await codeOf(installTheme(t.ctx, "https://example.com/bad.theme.css"))).toBe("bad-request");
	body = "x".repeat(2 * 1024 * 1024 + 1);
	expect(await codeOf(installTheme(t.ctx, "https://example.com/big.theme.css"))).toBe("bad-request");

	await setThemeEnabled(t.ctx, "e2e", true);
	await uninstallTheme(t.ctx, "e2e");
	expect(existsSync(path.join(t.ctx.paths.themes, "e2e.theme.css"))).toBe(false);
	expect((await readConfig(t.ctx.paths)).enabledThemes).toEqual([]);
	expect(await codeOf(uninstallTheme(t.ctx, "e2e"))).toBe("not-found");
	expect(await codeOf(installTheme(t.ctx, path.join(t.dir, "nope.theme.css")))).toBe("not-found");
});

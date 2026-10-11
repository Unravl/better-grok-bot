import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type CoreContext, createContext } from "../context.ts";
import { nullLogger } from "../log.ts";
import { installPathEntry, removePathEntry } from "./path-entry.ts";
import { fakeHost, recordingAdapter } from "./test-fakes.ts";

// The Windows branch edits the real user `Path`, so only the symlink form is exercised here.
describe.skipIf(process.platform === "win32")("~/.local/bin/bgb symlink", () => {
	let root: string;
	let home: string;
	let link: string;
	let ctx: CoreContext;

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "bgb-path-"));
		home = path.join(root, "home");
		link = path.join(home, ".local", "bin", "bgb");
		ctx = await createContext({ dataDir: path.join(root, "data"), platform: recordingAdapter([]), log: nullLogger });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("creates the link once and reports no hint while ~/.local/bin is on PATH", async () => {
		const host = fakeHost(home);
		expect(await installPathEntry(ctx, host)).toEqual({ created: true, hint: undefined });
		expect(await readlink(link)).toBe(path.join(ctx.paths.bin, "bgb"));
		expect(await installPathEntry(ctx, host)).toEqual({ created: false, hint: undefined });
	});

	test("hints how to add ~/.local/bin to PATH when it is missing", async () => {
		const result = await installPathEntry(ctx, fakeHost(home, { env: { PATH: "/usr/bin:/bin" } }));
		expect(result.created).toBe(true);
		expect(result.hint).toContain('export PATH="$HOME/.local/bin:$PATH"');
	});

	test("repoints a link to another bgb but never replaces a regular file", async () => {
		await mkdir(path.dirname(link), { recursive: true });
		await symlink("/elsewhere/bgb", link);
		expect((await installPathEntry(ctx, fakeHost(home))).created).toBe(true);
		expect(await readlink(link)).toBe(path.join(ctx.paths.bin, "bgb"));

		await rm(link);
		await writeFile(link, "#!/bin/sh\n");
		const result = await installPathEntry(ctx, fakeHost(home));
		expect(result.created).toBe(false);
		expect(result.hint).toContain("left it alone");
		expect(await readFile(link, "utf8")).toBe("#!/bin/sh\n");
	});

	test("removePathEntry removes only a link into DATA/bin", async () => {
		const host = fakeHost(home);
		await installPathEntry(ctx, host);
		await removePathEntry(ctx, host);
		expect(existsSync(link)).toBe(false);

		await symlink("/elsewhere/bgb", link);
		await removePathEntry(ctx, host);
		expect(await readlink(link)).toBe("/elsewhere/bgb");
	});
});

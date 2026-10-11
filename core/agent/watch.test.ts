import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readAppPackage } from "../app/package.ts";
import { dataPaths, ensureDataDir } from "../paths.ts";
import type { AppInstall } from "../platform/types.ts";
import { makeFixtureAsar } from "../test/fixtures.ts";
import { waitFor } from "./testing.ts";
import { type DataChange, watchApp, watchData } from "./watch.ts";

let dir: string;
const stops: (() => void)[] = [];

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "bgb-watch-"));
});

afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	await rm(dir, { recursive: true, force: true });
});

const renderer = { "index.html": "<script src=\"./assets/app.js\"></script>", "assets/app.js": "" };

function locator(asarPath: string): () => Promise<AppInstall> {
	return async () => ({
		kind: "custom",
		root: path.dirname(asarPath),
		executable: "",
		asarPath,
		version: (await readAppPackage(asarPath)).version,
	});
}

test("watchApp calls onChange exactly once when the asar's version and mtime change", async () => {
	const asarPath = await makeFixtureAsar(dir, { version: "0.68.1", renderer, asarPath: path.join(dir, "app.asar") });
	const seen: string[] = [];
	let polls = 0;
	const locate = locator(asarPath);
	stops.push(
		watchApp(
			async () => {
				polls++;
				return locate();
			},
			(app) => seen.push(app.version),
			50,
			{ settleMs: 50, debounceMs: 20 },
		),
	);
	await waitFor(() => polls >= 3, 2_000, "baseline polls");
	expect(seen).toEqual([]);

	await makeFixtureAsar(dir, { version: "0.69.0", renderer, asarPath });
	await waitFor(() => seen.length > 0, 10_000, "onChange");
	const after = polls;
	await waitFor(() => polls >= after + 5, 2_000, "later polls");
	expect(seen).toEqual(["0.69.0"]);
});

test("watchApp stays quiet for an unchanged asar and reports an app that appears later", async () => {
	const asarPath = path.join(dir, "late", "app.asar");
	const seen: string[] = [];
	let polls = 0;
	const locate = locator(asarPath);
	stops.push(
		watchApp(
			async () => {
				polls++;
				return locate();
			},
			(app) => seen.push(app.version),
			30,
			{ settleMs: 30 },
		),
	);
	await waitFor(() => polls >= 4, 2_000, "polls while missing");
	expect(seen).toEqual([]);
	await mkdir(path.dirname(asarPath), { recursive: true });
	await makeFixtureAsar(path.dirname(asarPath), { version: "0.70.0", renderer, asarPath });
	await waitFor(() => seen.length === 1, 5_000, "appearance");
	const after = polls;
	await waitFor(() => polls >= after + 5, 2_000, "quiet polls");
	expect(seen).toEqual(["0.70.0"]);
});

test("watchData reports config, plugin, theme and dev changes by kind", async () => {
	const paths = dataPaths(path.join(dir, "data"));
	await ensureDataDir(paths);
	const devDir = path.join(dir, "dev-plugin");
	await mkdir(devDir, { recursive: true });
	const batches: ReadonlySet<DataChange>[] = [];
	const watcher = await watchData(paths, (changes) => batches.push(changes), { debounceMs: 30, devDirs: [devDir] });
	stops.push(() => watcher.close());

	const expectChange = async (kind: DataChange, write: () => Promise<void>): Promise<void> => {
		batches.length = 0;
		await write();
		await waitFor(() => batches.some((batch) => batch.has(kind)), 5_000, `${kind} change`);
	};
	await expectChange("config", () => writeFile(paths.config, "{}"));
	await expectChange("devList", () => writeFile(paths.devPlugins, '{"dirs":[]}'));
	await expectChange("plugins", async () => {
		await mkdir(path.join(paths.plugins, "demo"), { recursive: true });
		await writeFile(path.join(paths.plugins, "demo", "plugin.json"), "{}");
	});
	await expectChange("themes", () => writeFile(path.join(paths.themes, "x.theme.css"), "/** @name X */"));
	await expectChange("dev", () => writeFile(path.join(devDir, "plugin.ts"), "export default {}"));
});

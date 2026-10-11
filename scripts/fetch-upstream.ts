#!/usr/bin/env bun
/**
 * Downloads, extracts or installs an upstream Grok Bot release from the public release feed.
 *
 *   bun scripts/fetch-upstream.ts (--platform <p> | --url <downloadUrl>) --format <dmg|exe|appimage|deb|rpm>
 *       [--extract <dir>] [--install] [--print-version] [--print-json]
 *
 * `--platform` ∈ darwin-arm64|darwin-x64|win32-x64|win32-arm64|linux-x64|linux-arm64 (Windows maps to
 * `<p>-user` in the feed). `--format` picks the feed field. `--url` downloads exactly that URL.
 * Downloads are cached in `.cache/upstream/<sha256(url)>/`. `--extract`/`--install` print the asar
 * path; with only `--print-*` nothing is downloaded; with no action the downloaded file path is printed.
 * `--install` overwrites the machine's Grok Bot and is refused unless `CI=true`.
 */
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { feedPlatformOf, feedUrlField, FORMATS, FORMATS_BY_OS, type Format, readFeed } from "./feed.ts";
import { download, REPO_ROOT, run, runMain, ScriptError, sha256Hex } from "./lib.ts";

const PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64", "linux-x64", "linux-arm64"] as const;

const USAGE = `usage: bun scripts/fetch-upstream.ts (--platform <${PLATFORMS.join("|")}> | --url <downloadUrl>) --format <${FORMATS.join("|")}> [--extract <dir>] [--install] [--print-version] [--print-json]`;

/** Downloads `url` once into `.cache/upstream/<sha256(url)>/<file name>`. */
async function cachedDownload(url: string): Promise<string> {
	const dir = path.join(REPO_ROOT, ".cache", "upstream", sha256Hex(url));
	const file = path.join(dir, decodeURIComponent(path.posix.basename(new URL(url).pathname)) || "download");
	if (await stat(file).catch(() => null)) {
		console.error(`[fetch] cached ${file}`);
		return file;
	}
	await mkdir(dir, { recursive: true });
	console.error(`[fetch] downloading ${url}`);
	await download(url, file);
	return file;
}

/** First `app.asar` under `root` (outside `app.asar.unpacked`), preferring `resources/app.asar`. */
async function findAsar(root: string): Promise<string> {
	const matches: string[] = [];
	for await (const rel of new Bun.Glob("**/app.asar").scan({ cwd: root, onlyFiles: true, dot: true, followSymlinks: false })) {
		matches.push(path.join(root, rel));
	}
	matches.sort((a, b) => a.length - b.length);
	const found = matches.find((file) => /[\\/]resources[\\/]app\.asar$/i.test(file)) ?? matches[0];
	if (!found) throw new ScriptError(`no app.asar found under ${root}`);
	return found;
}

/** Attaches a dmg read-only, runs `fn` with the mount point, then detaches it. */
async function withMountedDmg<T>(dmg: string, fn: (mount: string) => Promise<T>): Promise<T> {
	if (process.platform !== "darwin") throw new ScriptError("dmg images can only be opened on macOS");
	const mount = await mkdtemp(path.join(tmpdir(), "grok-dmg-"));
	await run(["hdiutil", "attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, dmg]);
	try {
		return await fn(mount);
	} finally {
		await run(["hdiutil", "detach", mount, "-force"], { allowFail: true });
		await rm(mount, { recursive: true, force: true }).catch(() => {});
	}
}

async function appInMount(mount: string): Promise<string> {
	const app = (await readdir(mount)).find((name) => name.endsWith(".app"));
	if (!app) throw new ScriptError(`no .app in the dmg (${(await readdir(mount)).join(", ")})`);
	return path.join(mount, app);
}

async function extract(file: string, format: Format, dest: string): Promise<string> {
	await mkdir(dest, { recursive: true });
	switch (format) {
		case "deb": {
			if (Bun.which("dpkg-deb")) {
				await run(["dpkg-deb", "-x", file, dest]);
			} else {
				// Hosts without dpkg (macOS): a .deb is an ar archive holding data.tar.*, which bsdtar reads.
				const work = await mkdtemp(path.join(tmpdir(), "grok-deb-"));
				try {
					await run(["tar", "-xf", file], { cwd: work });
					const data = (await readdir(work)).find((name) => name.startsWith("data.tar"));
					if (!data) throw new ScriptError(`no data.tar.* in ${file}`);
					await run(["tar", "-xf", path.join(work, data), "-C", dest]);
				} finally {
					await rm(work, { recursive: true, force: true });
				}
			}
			break;
		}
		case "rpm": {
			if (!Bun.which("rpm2cpio") || !Bun.which("cpio")) throw new ScriptError("extracting an rpm needs rpm2cpio and cpio");
			await run(["sh", "-c", 'rpm2cpio "$1" | cpio -idmu --quiet', "sh", file], { cwd: dest });
			break;
		}
		case "dmg":
			await withMountedDmg(file, async (mount) => {
				const app = await appInMount(mount);
				await run(["ditto", app, path.join(dest, path.basename(app))]);
			});
			break;
		case "exe": {
			const sevenZip = Bun.which("7z") ?? Bun.which("7zz");
			if (!sevenZip) throw new ScriptError("extracting the Windows installer needs 7z (p7zip-full)");
			const outer = await mkdtemp(path.join(tmpdir(), "grok-exe-"));
			try {
				await run([sevenZip, "x", "-y", `-o${outer}`, file]);
				const pluginsDir = path.join(outer, "$PLUGINSDIR");
				const inner = (await readdir(pluginsDir).catch(() => [] as string[])).find((name) => /^app-.*\.7z$/.test(name));
				if (!inner) {
					console.error((await run([sevenZip, "l", file], { allowFail: true })).stdout);
					throw new ScriptError("no $PLUGINSDIR/app-*.7z inside the installer (listing above)");
				}
				await run([sevenZip, "x", "-y", `-o${dest}`, path.join(pluginsDir, inner)]);
			} finally {
				await rm(outer, { recursive: true, force: true });
			}
			break;
		}
		case "appimage":
			await chmod(file, 0o755);
			await run([file, "--appimage-extract"], { cwd: dest });
			break;
	}
	return findAsar(dest);
}

async function install(file: string, format: Format): Promise<string> {
	switch (format) {
		case "dmg": {
			const target = "/Applications/Grok Bot.app";
			await withMountedDmg(file, async (mount) => {
				await rm(target, { recursive: true, force: true });
				await run(["ditto", await appInMount(mount), target]);
			});
			await run(["xattr", "-dr", "com.apple.quarantine", target], { allowFail: true });
			return path.join(target, "Contents", "Resources", "app.asar");
		}
		case "exe": {
			await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `Start-Process -Wait -FilePath '${file.replaceAll("'", "''")}' -ArgumentList '/S'`], {
				timeoutMs: 600_000,
			});
			const localAppData = process.env.LOCALAPPDATA;
			if (!localAppData) throw new ScriptError("LOCALAPPDATA is not set");
			const asarPath = path.join(localAppData, "Programs", "Grok Bot", "resources", "app.asar");
			if (!(await stat(asarPath).catch(() => null))) throw new ScriptError(`the installer finished but ${asarPath} does not exist`);
			return asarPath;
		}
		case "deb": {
			await run(["sudo", "apt-get", "install", "-y", path.resolve(file)], { inherit: true, timeoutMs: 600_000 });
			return "/opt/Grok Bot/resources/app.asar";
		}
		default:
			throw new ScriptError(`--install supports dmg, exe and deb, not ${format}`);
	}
}

await runMain("fetch-upstream", async () => {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			platform: { type: "string" },
			url: { type: "string" },
			format: { type: "string" },
			extract: { type: "string" },
			install: { type: "boolean" },
			"print-version": { type: "boolean" },
			"print-json": { type: "boolean" },
		},
		strict: true,
	});
	const format = values.format as Format | undefined;
	if (!format || !FORMATS.includes(format) || (values.platform === undefined) === (values.url === undefined)) {
		throw new ScriptError(USAGE, 2);
	}
	const printing = values["print-version"] || values["print-json"];

	let url: string;
	if (values.platform !== undefined) {
		if (!(PLATFORMS as readonly string[]).includes(values.platform)) throw new ScriptError(`unknown platform ${values.platform}\n${USAGE}`, 2);
		const feedPlatform = feedPlatformOf(values.platform);
		const os = values.platform.split("-")[0] ?? "";
		const notPublished = `${format} is not published for ${feedPlatform}`;
		if (!FORMATS_BY_OS[os]?.includes(format)) throw new ScriptError(notPublished);
		const entry = await readFeed(feedPlatform);
		const field = entry[feedUrlField(format)];
		if (!field) throw new ScriptError(notPublished);
		url = field;
		if (values["print-version"]) console.log(entry.version);
		if (values["print-json"]) {
			console.log(
				JSON.stringify({
					feedPlatform,
					version: entry.version,
					commitSha: entry.commitSha,
					downloadUrl: entry.downloadUrl,
					debUrl: entry.debUrl ?? null,
					rpmUrl: entry.rpmUrl ?? null,
				}),
			);
		}
	} else {
		if (printing) throw new ScriptError("--print-version and --print-json need --platform", 2);
		url = values.url ?? "";
	}
	if (printing && !values.extract && !values.install) return 0;
	// Agent and IDE shells often export CI=true too; only a GitHub Actions runner may install.
	if (values.install && (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true")) {
		throw new ScriptError("--install is for CI runners; it would overwrite your Grok Bot");
	}
	if (values.install && !["dmg", "exe", "deb"].includes(format)) throw new ScriptError(`--install supports dmg, exe and deb, not ${format}`);

	const file = await cachedDownload(url);
	if (values.extract) console.log(await extract(file, format, path.resolve(values.extract)));
	if (values.install) console.log(await install(file, format));
	if (!values.extract && !values.install) console.log(file);
	return 0;
});

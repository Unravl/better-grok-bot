import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ThemeInfo } from "../../sdk/index.ts";
import { type Config, mutateConfig, readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { BgbError, errorMessage } from "../errors.ts";
import { downloadBytes } from "../plugins/download.ts";
import { compareNames } from "../plugins/package.ts";

const MAX_THEME_BYTES = 2 * 1024 * 1024;
const SUFFIX = ".theme.css";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface ThemeHeader {
	name?: string;
	description?: string;
	author?: string;
	version?: string;
}

/** A theme file as read for one build: its info plus the exact bytes and text that info describes. */
export interface LoadedTheme {
	info: ThemeInfo;
	/** `undefined` when unreadable or too large. */
	bytes: Uint8Array | undefined;
	/** Present only for valid themes. */
	css: string | undefined;
}

/**
 * Parses a BetterDiscord-style header: the comment block at the very start of the file
 * (`/** @name X … *\/`), one or more `@key value` tags per line.
 */
export function parseThemeHeader(css: string): ThemeHeader {
	const block = /^\uFEFF?\s*\/\*([\s\S]*?)\*\//.exec(css)?.[1];
	if (block === undefined) return {};
	const header: ThemeHeader = {};
	for (const rawLine of block.split(/\r?\n/)) {
		const line = rawLine.replace(/^\s*\*+/, "");
		for (const match of line.matchAll(/(?:^|\s)@(\w+)\s+((?:(?!\s@\w+\s).)*)/g)) {
			const [, key, value = ""] = match;
			const text = value.trim();
			if (text === "") continue;
			if (key === "name" || key === "description" || key === "author" || key === "version") header[key] = text;
		}
	}
	return header;
}

/** Every `*.theme.css` in `DATA/themes`, sorted by id, with its bytes; invalid ones carry `error`. */
export async function loadThemes(ctx: CoreContext, config: Config): Promise<LoadedTheme[]> {
	let names: string[];
	try {
		names = await readdir(ctx.paths.themes);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const themes: LoadedTheme[] = [];
	for (const fileName of names.filter((name) => name.endsWith(SUFFIX) && name.length > SUFFIX.length).sort(compareNames)) {
		const id = fileName.slice(0, -SUFFIX.length);
		const enabled = config.enabledThemes.includes(id);
		const invalid = (error: string, bytes?: Uint8Array): LoadedTheme => ({
			info: { id, name: fileName, enabled, valid: false, error },
			bytes,
			css: undefined,
		});
		const file = path.join(ctx.paths.themes, fileName);
		let bytes: Uint8Array;
		try {
			if ((await stat(file)).size > MAX_THEME_BYTES) {
				themes.push(invalid("larger than 2 MB"));
				continue;
			}
			bytes = new Uint8Array(await readFile(file));
		} catch (error) {
			themes.push(invalid(`unreadable: ${errorMessage(error)}`));
			continue;
		}
		const css = new TextDecoder().decode(bytes);
		const header = parseThemeHeader(css);
		if (header.name === undefined) {
			themes.push(invalid("missing @name header", bytes));
			continue;
		}
		themes.push({ info: { id, ...header, name: header.name, enabled, valid: true }, bytes, css });
	}
	return themes;
}

export async function listThemes(ctx: CoreContext, config: Config): Promise<ThemeInfo[]> {
	return (await loadThemes(ctx, config)).map((theme) => theme.info);
}

/** CSS of the enabled, valid themes (what `themes.styles` returns and builds inject). */
export async function themeStyles(ctx: CoreContext, config: Config): Promise<{ id: string; css: string }[]> {
	const styles: { id: string; css: string }[] = [];
	for (const theme of await loadThemes(ctx, config)) {
		if (theme.info.enabled && theme.css !== undefined) styles.push({ id: theme.info.id, css: theme.css });
	}
	return styles;
}

/** Installs a theme from a local path or an `https://` URL; the file name (minus `.theme.css`) is its id. */
export async function installTheme(ctx: CoreContext, source: string): Promise<ThemeInfo> {
	let bytes: Uint8Array;
	let fileName: string;
	if (/^https:\/\//i.test(source)) {
		fileName = decodeURIComponent(new URL(source).pathname.split("/").pop() ?? "");
		bytes = await downloadBytes(source, { maxBytes: MAX_THEME_BYTES, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
		throw new BgbError("bad-request", `themes install from a local path or an https:// URL, not ${source}`);
	} else {
		const file = path.resolve(source);
		fileName = path.basename(file);
		try {
			if ((await stat(file)).size > MAX_THEME_BYTES) throw new BgbError("bad-request", `${file} is larger than 2 MB`);
			bytes = new Uint8Array(await readFile(file));
		} catch (error) {
			if (error instanceof BgbError) throw error;
			throw new BgbError("not-found", `cannot read ${file}: ${errorMessage(error)}`);
		}
	}
	const id = fileName.endsWith(SUFFIX) ? fileName.slice(0, -SUFFIX.length) : fileName.replace(/\.css$/i, "");
	if (!ID_PATTERN.test(id)) {
		throw new BgbError("bad-request", `theme file name ${JSON.stringify(fileName)} must be <id>.theme.css with letters, digits, "_", "." or "-"`);
	}
	const header = parseThemeHeader(new TextDecoder().decode(bytes));
	if (header.name === undefined) throw new BgbError("bad-request", `${fileName} has no @name header (/** @name My theme */ at the top)`);
	await mkdir(ctx.paths.themes, { recursive: true });
	const target = path.join(ctx.paths.themes, `${id}${SUFFIX}`);
	const temp = `${target}.tmp-${process.pid}`;
	await writeFile(temp, bytes);
	await rename(temp, target);
	const config = await readConfig(ctx.paths);
	return { id, ...header, name: header.name, enabled: config.enabledThemes.includes(id), valid: true };
}

export async function uninstallTheme(ctx: CoreContext, id: string): Promise<void> {
	if (!ID_PATTERN.test(id)) throw new BgbError("not-found", `no theme ${id}`);
	try {
		await rm(path.join(ctx.paths.themes, `${id}${SUFFIX}`));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BgbError("not-found", `no theme ${id}`);
		throw error;
	}
	await mutateConfig(ctx.paths, (config) => {
		config.enabledThemes = config.enabledThemes.filter((theme) => theme !== id);
	});
}

/** Edits `enabledThemes`. Unknown theme → `not-found`; enabling an invalid theme → `bad-request`. */
export async function setThemeEnabled(ctx: CoreContext, id: string, enabled: boolean): Promise<void> {
	await mutateConfig(ctx.paths, async (config) => {
		const theme = (await loadThemes(ctx, config)).find((candidate) => candidate.info.id === id);
		if (theme === undefined) throw new BgbError("not-found", `no theme ${id}`);
		if (enabled && !theme.info.valid) throw new BgbError("bad-request", `theme ${id} is invalid: ${theme.info.error ?? "unknown error"}`);
		const others = config.enabledThemes.filter((candidate) => candidate !== id);
		config.enabledThemes = enabled ? [...others, id] : others;
	});
}

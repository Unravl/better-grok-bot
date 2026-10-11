/**
 * Desktop entry files (https://specifications.freedesktop.org/desktop-entry/latest/) and the Linux hook:
 * the user's `grok-bot.desktop` override runs Grok Bot through `env VITE_DEV_SERVER_URL=<url>`.
 * Pure functions; no file system access.
 */
import { RENDERER_URL_ENV } from "../../sdk/index.ts";

export const MARKER_EXEC = "X-BetterGrokBot-Original-Exec";
export const MARKER_DBUS = "X-BetterGrokBot-Original-DBusActivatable";
export const MAIN_GROUP = "Desktop Entry";

export interface DesktopLine {
	/** The line as written; regenerated when `value` changes. */
	text: string;
	/** Group this line belongs to (`null` before the first group header). */
	group: string | null;
	/** Set for group headers. */
	header?: string;
	/** Set for `key=value` lines; `value` is the raw (still escaped) string. */
	key?: string;
	value?: string;
}

export interface DesktopFile {
	lines: DesktopLine[];
	/** The text ended with a newline. */
	trailingNewline: boolean;
}

const HEADER = /^\[([^\[\]]+)\]\s*$/;
const ENTRY = /^([A-Za-z0-9-]+(?:\[[^\]]+\])?)\s*=\s*(.*)$/;

/** Parses a desktop file, keeping every line (comments, blank lines, unknown keys) for serialization. */
export function parseDesktopFile(text: string): DesktopFile {
	const trailingNewline = text.endsWith("\n");
	const body = trailingNewline ? text.slice(0, -1) : text;
	const lines: DesktopLine[] = [];
	let group: string | null = null;
	if (body.length > 0 || trailingNewline) {
		for (const raw of body.split("\n")) {
			const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			const header = HEADER.exec(text);
			if (header?.[1] !== undefined) {
				group = header[1];
				lines.push({ text, group, header: group });
				continue;
			}
			const entry = group !== null && !text.startsWith("#") ? ENTRY.exec(text) : null;
			if (entry?.[1] !== undefined && entry[2] !== undefined) {
				lines.push({ text, group, key: entry[1], value: entry[2] });
			} else {
				lines.push({ text, group });
			}
		}
	}
	return { lines, trailingNewline };
}

export function serializeDesktopFile(file: DesktopFile): string {
	const text = file.lines.map((line) => line.text).join("\n");
	return file.trailingNewline ? `${text}\n` : text;
}

export function groupNames(file: DesktopFile): string[] {
	return file.lines.flatMap((line) => (line.header !== undefined ? [line.header] : []));
}

/** The raw value of `key` in `group` (the first one, as the spec forbids duplicates). */
export function getValue(file: DesktopFile, group: string, key: string): string | undefined {
	return file.lines.find((line) => line.group === group && line.key === key)?.value;
}

/** Sets `key` in place, or inserts it after the `after` key (default: after the group's last entry). */
export function setValue(file: DesktopFile, group: string, key: string, value: string, after?: string): void {
	const existing = file.lines.find((line) => line.group === group && line.key === key);
	if (existing) {
		existing.value = value;
		existing.text = `${key}=${value}`;
		return;
	}
	const line: DesktopLine = { text: `${key}=${value}`, group, key, value };
	let index = after === undefined ? -1 : file.lines.findIndex((l) => l.group === group && l.key === after);
	if (index === -1) {
		for (let i = 0; i < file.lines.length; i++) {
			const current = file.lines[i];
			if (current?.group === group && (current.key !== undefined || current.header !== undefined)) index = i;
		}
	}
	if (index === -1) {
		if (file.lines.length > 0 && file.lines[file.lines.length - 1]?.text !== "") file.lines.push({ text: "", group: null });
		file.lines.push({ text: `[${group}]`, group, header: group }, line);
		file.trailingNewline = true;
		return;
	}
	file.lines.splice(index + 1, 0, line);
}

export function deleteKey(file: DesktopFile, group: string, key: string): void {
	file.lines = file.lines.filter((line) => !(line.group === group && line.key === key));
}

const STRING_ESCAPES: Record<string, string> = { s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" };

/** The string-type layer: `\s` space, `\n`, `\t`, `\r`, `\\`; other escapes stay as written. */
export function unescapeValue(raw: string): string {
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch !== "\\" || i + 1 >= raw.length) {
			out += ch;
			continue;
		}
		const next = raw[i + 1];
		const mapped = STRING_ESCAPES[next ?? ""];
		if (mapped === undefined) {
			out += ch;
			continue;
		}
		out += mapped;
		i++;
	}
	return out;
}

/** The reverse of {@link unescapeValue} (spaces stay literal). */
export function escapeValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\t", "\\t").replaceAll("\r", "\\r");
}

const QUOTED_ESCAPABLE: Record<string, true> = { '"': true, "`": true, $: true, "\\": true };
const FIELD_CODES: Record<string, true> = { "%f": true, "%F": true, "%u": true, "%U": true, "%i": true, "%c": true, "%k": true };
const BARE_TOKEN = /^[A-Za-z0-9_\-./:=@%+,]+$/;

/** Splits a raw `Exec` value into arguments (field codes such as `%U` and `%%` are kept as written). */
export function parseExec(raw: string): string[] {
	const text = unescapeValue(raw);
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] ?? "";
		if (quoted) {
			if (ch === "\\" && QUOTED_ESCAPABLE[text[i + 1] ?? ""]) {
				current += text[i + 1];
				i++;
			} else if (ch === '"') {
				quoted = false;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === " " || ch === "\t") {
			if (started) tokens.push(current);
			current = "";
			started = false;
		} else if (ch === '"') {
			quoted = true;
			started = true;
		} else {
			current += ch;
			started = true;
		}
	}
	if (started) tokens.push(current);
	return tokens;
}

/** Joins arguments into a raw `Exec` value, quoting every token that is not plainly safe. */
export function serializeExec(tokens: readonly string[]): string {
	const parts = tokens.map((token) => {
		if (FIELD_CODES[token] || BARE_TOKEN.test(token)) return token;
		let quoted = '"';
		for (const ch of token) quoted += QUOTED_ESCAPABLE[ch] ? `\\${ch}` : ch;
		return `${quoted}"`;
	});
	return escapeValue(parts.join(" "));
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function isEnvProgram(token: string | undefined): boolean {
	return token === "env" || (token?.endsWith("/env") ?? false);
}

/** Drops a leading `env NAME=value…` wrapper. */
export function unwrapEnv(tokens: readonly string[]): string[] {
	if (!isEnvProgram(tokens[0])) return [...tokens];
	let i = 1;
	while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i] ?? "")) i++;
	return tokens.slice(i);
}

/** The `VITE_DEV_SERVER_URL` a raw `Exec` value sets through a leading `env`, with `%%` decoded. */
export function execRendererUrl(rawExec: string): string | null {
	const tokens = parseExec(rawExec);
	if (!isEnvProgram(tokens[0])) return null;
	for (const token of tokens.slice(1)) {
		if (!ENV_ASSIGNMENT.test(token)) break;
		if (token.startsWith(`${RENDERER_URL_ENV}=`)) return token.slice(RENDERER_URL_ENV.length + 1).replaceAll("%%", "%");
	}
	return null;
}

/** True when the entry carries our original-`Exec` marker. */
export function isHooked(text: string): boolean {
	return getValue(parseDesktopFile(text), MAIN_GROUP, MARKER_EXEC) !== undefined;
}

/** The URL our hook sets in `[Desktop Entry]`, or `null` when the entry is not hooked by BGB. */
export function hookedUrl(text: string): string | null {
	const file = parseDesktopFile(text);
	if (getValue(file, MAIN_GROUP, MARKER_EXEC) === undefined) return null;
	const exec = getValue(file, MAIN_GROUP, "Exec");
	return exec === undefined ? null : execRendererUrl(exec);
}

/** The URL `[Desktop Entry]` `Exec` sets, hooked by BGB or not. */
export function entryRendererUrl(text: string): string | null {
	const exec = getValue(parseDesktopFile(text), MAIN_GROUP, "Exec");
	return exec === undefined ? null : execRendererUrl(exec);
}

/**
 * Wraps `Exec` of `[Desktop Entry]` and every `[Desktop Action *]` in `env VITE_DEV_SERVER_URL=<url>`,
 * keeping the original in {@link MARKER_EXEC}, and turns D-Bus activation off (launchers ignore `Exec`
 * for D-Bus-activatable entries). Re-hooking starts from the stored originals, so it never wraps twice.
 */
export function hookEntry(text: string, url: string): string {
	const file = parseDesktopFile(text);
	for (const group of groupNames(file).filter((name) => name === MAIN_GROUP || name.startsWith("Desktop Action "))) {
		const original = getValue(file, group, MARKER_EXEC) ?? getValue(file, group, "Exec");
		if (original === undefined) continue;
		const program = unwrapEnv(parseExec(original));
		setValue(file, group, "Exec", serializeExec(["env", `${RENDERER_URL_ENV}=${url.replaceAll("%", "%%")}`, ...program]));
		setValue(file, group, MARKER_EXEC, original, "Exec");
	}
	if (getValue(file, MAIN_GROUP, MARKER_DBUS) === undefined && getValue(file, MAIN_GROUP, "DBusActivatable") === "true") {
		setValue(file, MAIN_GROUP, MARKER_DBUS, "true", "DBusActivatable");
		setValue(file, MAIN_GROUP, "DBusActivatable", "false");
	}
	return serializeDesktopFile(file);
}

/** Restores every hooked group's `Exec` and `DBusActivatable` from the markers and removes them. */
export function unhookEntry(text: string): string {
	const file = parseDesktopFile(text);
	for (const group of groupNames(file)) {
		const original = getValue(file, group, MARKER_EXEC);
		if (original !== undefined) {
			setValue(file, group, "Exec", original);
			deleteKey(file, group, MARKER_EXEC);
		}
		const dbus = getValue(file, group, MARKER_DBUS);
		if (dbus !== undefined) {
			setValue(file, group, "DBusActivatable", dbus);
			deleteKey(file, group, MARKER_DBUS);
		}
	}
	return serializeDesktopFile(file);
}

/** A fresh Grok Bot entry, used when neither the user nor the system has one. */
export function grokBotEntry(executable: string): string {
	return [
		`[${MAIN_GROUP}]`,
		"Type=Application",
		"Name=Grok Bot",
		`Exec=${serializeExec([executable, "%U"])}`,
		"Icon=grok-bot",
		"Terminal=false",
		"StartupWMClass=grok-bot",
		"MimeType=x-scheme-handler/grokbot;x-scheme-handler/sand;",
		"",
	].join("\n");
}

/** The XDG autostart entry that runs `bgb --data-dir <DATA> login` once per login session. */
export function autostartEntry(binPath: string, dataDir: string): string {
	return [
		`[${MAIN_GROUP}]`,
		"Type=Application",
		"Name=Better Grok Bot",
		"Comment=Starts the Better Grok Bot agent",
		`Exec=${serializeExec([binPath, "--data-dir", dataDir, "login"])}`,
		"Terminal=false",
		"NoDisplay=true",
		"X-GNOME-Autostart-enabled=true",
		"",
	].join("\n");
}

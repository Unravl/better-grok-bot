import { describe, expect, test } from "bun:test";
import {
	MARKER_DBUS,
	MARKER_EXEC,
	autostartEntry,
	entryRendererUrl,
	escapeValue,
	hookEntry,
	hookedUrl,
	parseDesktopFile,
	parseExec,
	serializeDesktopFile,
	serializeExec,
	unescapeValue,
	unhookEntry,
	unwrapEnv,
} from "./desktop-entry.ts";

const URL = "file:///home/u/.local/share/Better%20Grok/current/renderer/index.html?bgb";
/** The env token as written in the file: `%` doubled, quoted because of `?`. */
const ENV = '"VITE_DEV_SERVER_URL=file:///home/u/.local/share/Better%%20Grok/current/renderer/index.html?bgb"';

describe("Exec table", () => {
	const cases: { name: string; raw: string; tokens: string[]; hooked: string }[] = [
		{
			name: "bare program with %U",
			raw: "grok-bot %U",
			tokens: ["grok-bot", "%U"],
			hooked: `env ${ENV} grok-bot %U`,
		},
		{
			name: "AppImage path with spaces and %F",
			raw: '"/home/u/My Apps/Grok Bot.AppImage" %F',
			tokens: ["/home/u/My Apps/Grok Bot.AppImage", "%F"],
			hooked: `env ${ENV} "/home/u/My Apps/Grok Bot.AppImage" %F`,
		},
		{
			name: "quoted argument with backslash, dollar and backtick",
			raw: 'grok-bot "--title=a\\\\\\\\b \\\\$HOME \\\\`x\\\\`" %U',
			tokens: ["grok-bot", "--title=a\\b $HOME `x`", "%U"],
			hooked: `env ${ENV} grok-bot "--title=a\\\\\\\\b \\\\$HOME \\\\\`x\\\\\`" %U`,
		},
		{
			name: "literal percent kept as written",
			raw: "grok-bot --volume=100%% %u",
			tokens: ["grok-bot", "--volume=100%%", "%u"],
			hooked: `env ${ENV} grok-bot --volume=100%% %u`,
		},
		{
			name: "existing env wrapper is replaced",
			raw: "env FOO=1 /usr/bin/grok-bot %U",
			tokens: ["env", "FOO=1", "/usr/bin/grok-bot", "%U"],
			hooked: `env ${ENV} /usr/bin/grok-bot %U`,
		},
	];

	for (const c of cases) {
		test(c.name, () => {
			expect(parseExec(c.raw)).toEqual(c.tokens);
			const file = `[Desktop Entry]\nExec=${c.raw}\n`;
			const hooked = hookEntry(file, URL);
			expect(hooked).toBe(`[Desktop Entry]\nExec=${c.hooked}\n${MARKER_EXEC}=${c.raw}\n`);
			expect(hookedUrl(hooked)).toBe(URL);
			expect(unhookEntry(hooked)).toBe(file);
			const hookedTokens = parseExec(c.hooked);
			expect(unwrapEnv(hookedTokens)).toEqual(unwrapEnv(c.tokens));
			for (const tokens of [c.tokens, hookedTokens]) expect(parseExec(serializeExec(tokens))).toEqual(tokens);
		});
	}

	test("single-backslash escapes inside quotes also parse", () => {
		expect(parseExec('a "\\$HOME \\"q\\""')).toEqual(["a", '$HOME "q"']);
	});

	test("string escapes", () => {
		expect(unescapeValue("a\\sb\\nc\\td\\re\\\\f\\$")).toBe("a b\nc\td\re\\f\\$");
		expect(escapeValue("a\\b\nc")).toBe("a\\\\b\\nc");
		expect(parseExec("grok-bot\\s%U")).toEqual(["grok-bot", "%U"]);
	});

	test("empty quoted argument survives", () => {
		expect(parseExec('a "" b')).toEqual(["a", "", "b"]);
		expect(parseExec(serializeExec(["a", "", "b"]))).toEqual(["a", "", "b"]);
	});
});

describe("hookEntry", () => {
	const original = [
		"# Grok Bot launcher",
		"[Desktop Entry]",
		"Name=Grok Bot",
		"Exec=grok-bot %U",
		"DBusActivatable=true",
		"X-Custom=keep me",
		"Actions=new-window;",
		"",
		"[Desktop Action new-window]",
		"Name=New Window",
		"Exec=grok-bot --new-window %U",
		"",
	].join("\n");

	test("hooks the entry and every action, disabling D-Bus activation", () => {
		const hooked = hookEntry(original, URL);
		expect(hooked).toBe(
			[
				"# Grok Bot launcher",
				"[Desktop Entry]",
				"Name=Grok Bot",
				`Exec=env ${ENV} grok-bot %U`,
				`${MARKER_EXEC}=grok-bot %U`,
				"DBusActivatable=false",
				`${MARKER_DBUS}=true`,
				"X-Custom=keep me",
				"Actions=new-window;",
				"",
				"[Desktop Action new-window]",
				"Name=New Window",
				`Exec=env ${ENV} grok-bot --new-window %U`,
				`${MARKER_EXEC}=grok-bot --new-window %U`,
				"",
			].join("\n"),
		);
		expect(unhookEntry(hooked)).toBe(original);
	});

	test("re-hooking with a new URL rebuilds from the originals", () => {
		const other = "file:///data/current/renderer/index.html?bgb";
		const twice = hookEntry(hookEntry(original, URL), other);
		expect(twice).toBe(hookEntry(original, other));
		expect(hookedUrl(twice)).toBe(other);
		expect(twice.match(/env /g)?.length).toBe(2);
		expect(unhookEntry(twice)).toBe(original);
	});

	test("entryRendererUrl sees foreign env values; hookedUrl only ours", () => {
		const foreign = "[Desktop Entry]\nExec=env VITE_DEV_SERVER_URL=http://localhost:5173 grok-bot\n";
		expect(entryRendererUrl(foreign)).toBe("http://localhost:5173");
		expect(hookedUrl(foreign)).toBeNull();
	});

	test("parse/serialize keeps comments, CRLF-free order and a missing trailing newline", () => {
		const text = "#c\n[Desktop Entry]\nName[de]=Grok\nExec = grok-bot";
		expect(serializeDesktopFile(parseDesktopFile(text))).toBe(text);
		expect(parseExec(parseDesktopFile(text).lines[3]?.value ?? "")).toEqual(["grok-bot"]);
	});
});

test("autostart entry runs login with the data dir", () => {
	const text = autostartEntry("/home/u/.local/share/My Data/bin/bgb", "/home/u/.local/share/My Data");
	const exec = /^Exec=(.*)$/m.exec(text)?.[1] ?? "";
	expect(parseExec(exec)).toEqual(["/home/u/.local/share/My Data/bin/bgb", "--data-dir", "/home/u/.local/share/My Data", "login"]);
	expect(text).toContain("NoDisplay=true\n");
	expect(text).toContain("X-GNOME-Autostart-enabled=true\n");
});

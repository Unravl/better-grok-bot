import { describe, expect, test } from "bun:test";
import { pluginStatus } from "../test/fakes.ts";
import { buildPluginRows, buildThemeRows, installConfirmMessage } from "./model.ts";

describe("plugin rows", () => {
	test("a local runtime-failed overrides the agent's active state and shows the local error", () => {
		const agent = [pluginStatus({ id: "startup", name: "Startup", description: "Starts voice." })];
		const local = [pluginStatus({ id: "startup", state: "runtime-failed", errors: ["runtime threw: no client"] })];
		const [row] = buildPluginRows(agent, [], local);
		expect(row).toMatchObject({ id: "startup", state: "runtime-failed", description: "Starts voice. — runtime threw: no client", enabled: true });
		expect(row?.fields).toEqual([]);
	});

	test("an invalid duplicate of an id gets its own row key and keeps its own state", () => {
		const agent = [
			pluginStatus({ id: "push-to-talk", name: "Push to talk", source: "bundled" }),
			pluginStatus({ id: "push-to-talk", name: "push-to-talk", source: "community", state: "invalid", errors: ['id "push-to-talk" is reserved'] }),
		];
		const local = [
			pluginStatus({ id: "push-to-talk", source: "bundled", state: "runtime-failed", errors: ["runtime threw: boom"] }),
			pluginStatus({ id: "push-to-talk", source: "community", state: "invalid", errors: ['id "push-to-talk" is reserved'] }),
		];
		const rows = buildPluginRows(agent, [], local);
		expect(rows.map((row) => [row.key, row.state, row.description])).toEqual([
			["bundled:push-to-talk", "runtime-failed", "runtime threw: boom"],
			["community:push-to-talk", "invalid", 'id "push-to-talk" is reserved'],
		]);
	});

	test("a locally failed plugin the agent reports disabled renders off and toggles back on", () => {
		const agent = [pluginStatus({ id: "startup", state: "disabled" })];
		const local = [pluginStatus({ id: "startup", state: "runtime-failed", errors: ["runtime threw: no client"] })];
		const [row] = buildPluginRows(agent, [], local);
		expect(row).toMatchObject({ state: "runtime-failed", description: "runtime threw: no client", enabled: false, canToggle: true });
	});

	test("settings rows keep the schema this page loaded when the agent reports a newer one", () => {
		const loaded = { on: { type: "boolean", label: "On", default: true } } as const;
		const manifest = [pluginStatus({ id: "voice", settings: loaded })];
		const agent = [pluginStatus({ id: "voice", settings: { ...loaded, level: { type: "number", label: "Level", default: 1, min: 0, max: 2 } } })];
		const [row] = buildPluginRows(agent, manifest, []);
		expect(row?.fields.map((field) => field.name)).toEqual(["on"]);
		expect(row?.settings).toEqual(loaded);

		const [installedLater] = buildPluginRows(agent, [], []);
		expect(installedLater?.fields.map((field) => field.name)).toEqual(["on", "level"]);
	});

	test("a duplicate id never takes another source's loaded schema", () => {
		const loaded = { on: { type: "boolean", label: "On", default: true } } as const;
		const manifest = [pluginStatus({ id: "voice", source: "bundled", settings: loaded })];
		const agent = [pluginStatus({ id: "voice", source: "bundled" }), pluginStatus({ id: "voice", source: "community", state: "invalid" })];
		const rows = buildPluginRows(agent, manifest, []);
		expect(rows.map((row) => [row.key, row.settings])).toEqual([
			["bundled:voice", loaded],
			["community:voice", {}],
		]);
	});

	test("hides core hooks; bundled first, then community and dev by name, with source labels", () => {
		const rows = buildPluginRows(
			[
				pluginStatus({ id: "zeta", name: "Zeta", source: "community" }),
				pluginStatus({ id: "bgb-react", name: "React", source: "core" }),
				pluginStatus({ id: "voice", name: "Voice", source: "bundled" }),
				pluginStatus({ id: "alpha", name: "Alpha", source: "dev" }),
				pluginStatus({ id: "output", name: "Output", source: "bundled" }),
			],
			[],
			[],
		);
		expect(rows.map((row) => row.label)).toEqual(["Output", "Voice", "Alpha · dev", "Zeta · community"]);
		expect(rows.map((row) => row.community)).toEqual([false, false, false, true]);
	});

	test("falls back to the manifest; states shape the toggle and description", () => {
		const rows = buildPluginRows(
			null,
			[
				pluginStatus({ id: "a", name: "A", state: "disabled" }),
				pluginStatus({ id: "b", name: "B", state: "patch-failed", errors: ["patch x matched 0 times, expected 1"] }),
				pluginStatus({ id: "c", name: "C", state: "unsupported-platform" }),
				pluginStatus({ id: "d", name: "D", settings: { on: { type: "boolean", label: "On", default: true } } }),
			],
			[],
		);
		expect(rows.map(({ enabled, canToggle, description }) => ({ enabled, canToggle, description }))).toEqual([
			{ enabled: false, canToggle: true, description: "" },
			{ enabled: true, canToggle: true, description: "patch x matched 0 times, expected 1" },
			{ enabled: true, canToggle: false, description: "Not available on this OS" },
			{ enabled: true, canToggle: true, description: "" },
		]);
		expect(rows[3]?.fields.map((field) => field.name)).toEqual(["on"]);
	});
});

describe("theme rows and confirmations", () => {
	test("invalid themes show their error and are never on", () => {
		const rows = buildThemeRows(
			[
				{ id: "broken", name: "broken.theme.css", enabled: true, valid: false, error: "missing @name header" },
				{ id: "dark", name: "Dark", description: "Darker", author: "Ann", enabled: true, valid: true },
			],
			[],
		);
		expect(rows).toEqual([
			{ id: "broken", label: "broken.theme.css", description: "missing @name header", enabled: false, valid: false },
			{ id: "dark", label: "Dark", description: "Darker · by Ann", enabled: true, valid: true },
		]);
	});

	test("the install confirmation lists permissions and the replaced version", () => {
		const message = installConfirmMessage({
			inspectionId: "0123456789abcdef",
			sha256: "s",
			id: "ptt-plus",
			name: "PTT Plus",
			version: "2.0.0",
			description: "More keys.",
			permissions: ["keys", "media"],
			replaces: { version: "1.0.0", granted: ["keys"], enabled: true },
		});
		expect(message).toContain("Install PTT Plus 2.0.0?");
		expect(message).toContain("• keys: listen to a key while Grok Bot is in the background");
		expect(message).toContain("• media: lower other apps' volume");
		expect(message).toContain("This replaces version 1.0.0.");
	});
});

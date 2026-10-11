import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATED_FLAG, migrateGrokModsStorage } from "./migrate.ts";
import { recordingLogger } from "./test/fakes.ts";

beforeAll(() => GlobalRegistrator.register({ url: "file:///data/current/renderer/index.html?bgb" }));
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => localStorage.clear());

describe("grok-mods storage migration", () => {
	test("copies grok-mods:<id>:<key> to bgb:<id>:<key> only where the target is absent", () => {
		localStorage.setItem("grok-mods:push-to-talk:binding", '"AltRight"');
		localStorage.setItem("grok-mods:push-to-talk:enabled", "false");
		localStorage.setItem("grok-mods:startup:mode:nested", '"voice"');
		localStorage.setItem("bgb:push-to-talk:enabled", "true");
		localStorage.setItem("unrelated", "1");
		migrateGrokModsStorage(localStorage, recordingLogger());
		expect(localStorage.getItem("bgb:push-to-talk:binding")).toBe('"AltRight"');
		expect(localStorage.getItem("bgb:push-to-talk:enabled")).toBe("true");
		expect(localStorage.getItem("bgb:startup:mode:nested")).toBe('"voice"');
		expect(localStorage.getItem("grok-mods:push-to-talk:binding")).toBe('"AltRight"');
		expect(localStorage.getItem(MIGRATED_FLAG)).toBe("1");
	});

	test("runs once: later grok-mods values are not copied again", () => {
		migrateGrokModsStorage(localStorage, recordingLogger());
		localStorage.setItem("grok-mods:startup:mode", '"voice"');
		migrateGrokModsStorage(localStorage, recordingLogger());
		expect(localStorage.getItem("bgb:startup:mode")).toBeNull();
	});
});

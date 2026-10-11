import { describe, expect, test } from "bun:test";
import type { UiPrimitives } from "../sdk/index.ts";
import { createHookRegistry } from "./hooks.ts";
import { createFakeReact, recordingLogger, type FakeElement } from "./test/fakes.ts";

const ui: UiPrimitives = { Section: "Section", Row: "Row", Toggle: "Toggle", Select: "Select", Button: "Button", textStyles: { body2: {} } };
function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	queueMicrotask(resolve);
	return promise;
}

describe("core hook registry", () => {
	test("provideClient notifies listeners once per identity change, in a microtask", async () => {
		const hooks = createHookRegistry({ log: recordingLogger(), createSection: () => () => null });
		const seen: unknown[] = [];
		hooks.app.onClient((client) => seen.push(client));
		const first = { name: "first" };
		const second = { name: "second" };
		expect(hooks.provideClient(first)).toBe(first);
		expect(seen).toEqual([]);
		await tick();
		hooks.provideClient(first);
		hooks.provideClient(null);
		await tick();
		expect(seen).toEqual([first]);
		hooks.provideClient(second);
		await tick();
		expect(seen).toEqual([first, second]);
		expect(hooks.app.client).toBe(second);
	});

	test("a late onClient listener gets the current client in a microtask", async () => {
		const hooks = createHookRegistry({ log: recordingLogger(), createSection: () => () => null });
		const client = { id: 1 };
		hooks.provideClient(client);
		await tick();
		const seen: unknown[] = [];
		hooks.app.onClient((next) => seen.push(next));
		expect(seen).toEqual([]);
		await tick();
		expect(seen).toEqual([client]);
	});

	test("provideReact: first valid call wins and publishes React and jsx", () => {
		const hooks = createHookRegistry({ log: recordingLogger(), createSection: () => () => null });
		const first = createFakeReact();
		hooks.provideReact({ not: "react" });
		expect(hooks.React).toBeUndefined();
		hooks.provideReact(first);
		hooks.provideReact(createFakeReact());
		expect(hooks.React).toBe(first);
		expect(hooks.app.React).toBe(first);
		expect(hooks.app.jsx?.("div", { id: "x" }, "k")).toEqual({ type: "div", key: "k", props: { id: "x" } });
	});

	test("settingsSection returns a keyed element carrying ui and records ui for plugins", () => {
		const hooks = createHookRegistry({ log: recordingLogger(), createSection: () => () => "section" });
		expect(hooks.settingsSection(ui)).toBeNull();
		hooks.provideReact(createFakeReact());
		const element = hooks.settingsSection(ui) as FakeElement;
		expect(element.key).toBe("bgb");
		expect(element.props.ui).toBe(ui);
		expect(hooks.app.ui).toBe(ui);
		expect(hooks.settingsSection(ui)).toMatchObject({ type: element.type });
	});

	test("every hook returns its fallback when its internals throw", () => {
		const log = recordingLogger();
		const hooks = createHookRegistry({
			log,
			createSection: () => () => null,
			schedule: () => {
				throw new Error("no microtasks");
			},
		});
		const hostile = new Proxy(
			{},
			{
				get() {
					throw new Error("hostile");
				},
			},
		);
		expect(hooks.provideReact(hostile)).toBeUndefined();
		const client = { id: 1 };
		expect(hooks.provideClient(client)).toBe(client);
		const React = createFakeReact();
		hooks.provideReact({
			...React,
			createElement: () => {
				throw new Error("createElement failed");
			},
		});
		expect(hooks.settingsSection(ui)).toBeNull();
		expect(log.lines.some((line) => line.includes("provideReact failed"))).toBe(true);
		expect(log.lines.some((line) => line.includes("provideClient failed"))).toBe(true);
		expect(log.lines.some((line) => line.includes("settings section failed"))).toBe(true);
	});
});

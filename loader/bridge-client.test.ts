import { describe, expect, test } from "bun:test";
import { SidebarError, type SidebarResult } from "../sdk/index.ts";
import { BridgeRequestError, createBridgeClient, RECONNECT_MAX_MS, type BridgeClient } from "./bridge-client.ts";
import { createFakeSockets, FakeClock, fakeGlobals, recordingLogger, settle } from "./test/fakes.ts";

function setup(port = 39320) {
	const fake = createFakeSockets();
	const clock = new FakeClock();
	const client: BridgeClient = createBridgeClient({
		port,
		token: "secret-token",
		buildKey: "build-key",
		appVersion: "0.68.1",
		bgbVersion: "0.1.0",
		globals: fakeGlobals(fake.WebSocket),
		clock,
		log: recordingLogger(),
	});
	return { ...fake, clock, client };
}

describe("bridge client", () => {
	test("greets with hello and reports connected after welcome", () => {
		const { client, last } = setup();
		const states: string[] = [];
		client.subscribe((state) => states.push(state));
		client.start();
		const socket = last();
		expect(socket.url).toBe("ws://127.0.0.1:39320/bgb");
		socket.accept();
		expect(socket.sent[0]).toEqual({
			type: "hello",
			protocol: 1,
			token: "secret-token",
			buildKey: "build-key",
			appVersion: "0.68.1",
			bgbVersion: "0.1.0",
			capabilities: ["sidebar-folders"],
		});
		expect(client.state).toBe("connecting");
		socket.welcome();
		expect(client.state).toBe("connected");
		expect(states).toEqual(["connecting", "connected"]);
	});

	test("reconnects with exponential backoff capped at 30 s, reset after a welcome", () => {
		const { client, sockets, clock } = setup();
		client.start();
		expect(sockets).toHaveLength(1);
		const delays: number[] = [];
		for (let attempt = 0; attempt < 7; attempt++) {
			sockets.at(-1)?.drop();
			const before = sockets.length;
			let waited = 0;
			while (sockets.length === before) {
				clock.advance(100);
				waited += 100;
			}
			delays.push(waited);
		}
		expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, RECONNECT_MAX_MS, RECONNECT_MAX_MS]);

		const socket = sockets.at(-1);
		socket?.accept();
		socket?.welcome();
		socket?.drop();
		const before = sockets.length;
		clock.advance(999);
		expect(sockets).toHaveLength(before);
		clock.advance(1);
		expect(sockets).toHaveLength(before + 1);
	});

	test("resolves responses and maps agent errors to BridgeRequestError", async () => {
		const { client, last } = setup();
		client.start();
		const socket = last();
		socket.accept();
		socket.welcome();
		const ok = client.request("plugins.setEnabled", { id: "startup", enabled: false });
		const bad = client.request("plugins.setEnabled", { id: "bgb-react", enabled: false });
		const [first, second] = socket.requests("plugins.setEnabled");
		expect(first?.params).toEqual({ id: "startup", enabled: false });
		if (first === undefined || second === undefined) throw new Error("requests not sent");
		socket.fail(second, "bad-request", "core hooks are always enabled");
		socket.reply(first, {});
		expect(await ok).toEqual({});
		const error = await bad.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(BridgeRequestError);
		expect(error).toMatchObject({ code: "bad-request", message: "core hooks are always enabled" });
	});

	test("a request times out after its method deadline", async () => {
		const { client, last, clock } = setup();
		client.start();
		last().accept();
		last().welcome();
		const quick = client.request("status.get", {});
		const slow = client.request("plugins.inspect", { source: "github:a/b" });
		let slowSettled = false;
		slow.catch(() => undefined).finally(() => {
			slowSettled = true;
		});
		clock.advance(30_000);
		expect(await quick.catch((error: unknown) => error)).toMatchObject({ code: "unavailable", message: "status.get timed out after 30 s" });
		await Promise.resolve();
		expect(slowSettled).toBe(false);
		clock.advance(60_000);
		expect(await slow.catch((error: unknown) => error)).toMatchObject({ code: "unavailable", message: "plugins.inspect timed out after 90 s" });
	});

	test("requests fail fast while disconnected and pending ones fail when the socket closes", async () => {
		const { client, last } = setup();
		expect(await client.request("status.get", {}).catch((error: unknown) => error)).toMatchObject({ code: "unavailable" });
		client.start();
		last().accept();
		last().welcome();
		const pending = client.request("status.get", {});
		last().drop();
		expect(await pending.catch((error: unknown) => error)).toMatchObject({ code: "unavailable" });
		expect(client.state).toBe("disconnected");
	});

	test("bridge.moving switches to the new port right away with the same token", () => {
		const { client, sockets, last } = setup();
		const moves: unknown[] = [];
		client.on("bridge.moving", (data) => moves.push(data));
		client.start();
		const old = last();
		old.accept();
		old.welcome();
		old.event("bridge.moving", { port: 39321 });
		expect(moves).toEqual([{ port: 39321 }]);
		expect(old.closedWith).toBe(1000);
		expect(sockets).toHaveLength(2);
		const moved = last();
		expect(moved.url).toBe("ws://127.0.0.1:39321/bgb");
		moved.accept();
		expect(moved.sent[0]).toMatchObject({ type: "hello", token: "secret-token" });
		expect(client.port).toBe(39321);
	});

	test("events reach listeners; a socket without a welcome is abandoned after 10 s", () => {
		const { client, sockets, last, clock } = setup();
		client.start();
		const silent = last();
		silent.accept();
		clock.advance(10_000);
		expect(silent.closedWith).toBeDefined();
		expect(client.state).toBe("disconnected");
		clock.advance(1_000);
		expect(sockets).toHaveLength(2);
		const socket = last();
		socket.accept();
		socket.welcome();
		const finished: unknown[] = [];
		client.on("build.finished", (data) => finished.push(data));
		socket.event("build.finished", { buildKey: "k", ok: true, appVersion: "0.68.1", failed: [] });
		expect(finished).toEqual([{ buildKey: "k", ok: true, appVersion: "0.68.1", failed: [] }]);
	});

	test("stop closes the socket and never reconnects", () => {
		const { client, sockets, last, clock } = setup();
		client.start();
		last().accept();
		last().welcome();
		client.stop();
		expect(last().closedWith).toBe(1000);
		clock.advance(60_000);
		expect(sockets).toHaveLength(1);
		expect(client.state).toBe("disconnected");
	});
});

describe("addressed sidebar commands", () => {
	test("invalid commands, extra frame fields, missing handlers and invalid results fail honestly", async () => {
		const { client, last } = setup();
		client.start();
		const socket = last();
		socket.accept();
		socket.receive({ type: "sidebar.req", id: 1, command: { operation: "create-folder", name: "Early" } });
		expect(socket.sent.filter((frame) => frame.type === "sidebar.res")).toEqual([]);
		socket.welcome();
		socket.receive({ type: "sidebar.req", id: 1, command: { operation: "list-folders" } });
		expect(socket.sent.at(-1)).toMatchObject({ type: "sidebar.res", id: 1, ok: false, error: { code: "unavailable" } });
		let calls = 0;
		const unsubscribe = client.onSidebarRequest(async () => {
			calls++;
			return { operation: "list-bots", bots: [] };
		});
		socket.receive({ type: "sidebar.req", id: 2, command: { operation: "create-folder", name: "Folder", rendererConnectionId: 9 } });
		socket.receive({ type: "sidebar.req", id: 3, command: { operation: "list-folders" }, pluginId: "other" });
		socket.receive({ type: "sidebar.req", id: 3.5, command: { operation: "list-folders" } });
		expect(calls).toBe(0);
		expect(socket.sent.filter((frame) => frame.type === "sidebar.res").map((frame) => frame.id)).toEqual([1, 2, 3]);
		expect(socket.sent.slice(-2)).toEqual([
			{ type: "sidebar.res", id: 2, ok: false, error: { code: "bad-request", message: "Invalid sidebar command" } },
			{ type: "sidebar.res", id: 3, ok: false, error: { code: "bad-request", message: "Invalid sidebar request frame" } },
		]);
		socket.receive({ type: "sidebar.req", id: 4, command: { operation: "list-folders" } });
		await settle(() => socket.sent.some((frame) => frame.type === "sidebar.res" && frame.id === 4));
		expect(socket.sent.at(-1)).toMatchObject({ id: 4, ok: false, error: { code: "internal", message: expect.stringContaining("outcome is unknown") } });
		unsubscribe();
		socket.receive({ type: "sidebar.req", id: 5, command: { operation: "list-bots" } });
		expect(socket.sent.at(-1)).toMatchObject({ id: 5, ok: false, error: { code: "unavailable" } });
		expect(calls).toBe(1);
		client.stop();
	});

	test("SidebarError code and candidate data survive without becoming internal", async () => {
		const { client, last } = setup();
		const candidates = [{ id: "folder-a", name: "Work" }, { id: "folder-b", name: "work" }];
		client.onSidebarRequest(async () => {
			throw new SidebarError("conflict", "Ambiguous folder selector", { candidates });
		});
		client.start();
		last().accept();
		last().welcome();
		last().receive({ type: "sidebar.req", id: 1, command: { operation: "delete-folder", folder: "WORK" } });
		await settle(() => last().sent.some((frame) => frame.type === "sidebar.res"));
		expect(last().sent.at(-1)).toEqual({
			type: "sidebar.res", id: 1, ok: false,
			error: { code: "conflict", message: "Ambiguous folder selector", data: { candidates } },
		});
		client.stop();
	});

	test("a distinct SidebarError constructor preserves finite codes and data, but invalid shapes remain internal", async () => {
		// Separate loader/plugin IIFEs instantiate independent SDK constructors.
		class PluginSidebarError extends Error {
			constructor(readonly code: unknown, message: string, readonly data?: unknown) {
				super(message);
				this.name = "SidebarError";
			}
		}
		const { client, last } = setup();
		const candidates = [{ id: "work-a", name: "Work" }, { id: "work-b", name: "WORK" }];
		const errors: unknown[] = [
			new PluginSidebarError("conflict", "Ambiguous folder selector", { candidates }),
			new PluginSidebarError("not-found", "Bot is not in this window", { bot: "missing" }),
			new PluginSidebarError("invented-code", "Unrecognized failure", { mustNotEscape: true }),
			{ name: "SidebarError", code: "conflict", message: 12, data: { mustNotEscape: true } },
		];
		expect(errors[0]).not.toBeInstanceOf(SidebarError);
		client.onSidebarRequest(async () => {
			throw errors.shift();
		});
		client.start();
		const socket = last();
		socket.accept();
		socket.welcome();
		for (let id = 1; id <= 4; id++) {
			socket.receive({ type: "sidebar.req", id, command: { operation: "list-folders" } });
			await settle(() => socket.sent.some((frame) => frame.type === "sidebar.res" && frame.id === id));
		}
		expect(socket.sent.filter((frame) => frame.type === "sidebar.res")).toEqual([
			{ type: "sidebar.res", id: 1, ok: false, error: { code: "conflict", message: "Ambiguous folder selector", data: { candidates } } },
			{ type: "sidebar.res", id: 2, ok: false, error: { code: "not-found", message: "Bot is not in this window", data: { bot: "missing" } } },
			{ type: "sidebar.res", id: 3, ok: false, error: { code: "internal", message: "Unrecognized failure" } },
			{ type: "sidebar.res", id: 4, ok: false, error: { code: "internal", message: "[object Object]" } },
		]);
		client.stop();
	});

	test("concurrent replies retain request ids and duplicate mutations execute only once", async () => {
		const { client, last } = setup();
		const created = Promise.withResolvers<SidebarResult>();
		const deleted = Promise.withResolvers<SidebarResult>();
		const operations: string[] = [];
		client.onSidebarRequest((command) => {
			operations.push(command.operation);
			return command.operation === "create-folder" ? created.promise : deleted.promise;
		});
		client.start();
		const socket = last();
		socket.accept();
		socket.welcome();
		socket.receive({ type: "sidebar.req", id: 1, command: { operation: "create-folder", name: "Work" } });
		socket.receive({ type: "sidebar.req", id: 2, command: { operation: "delete-folder", folder: "old" } });
		socket.receive({ type: "sidebar.req", id: 1, command: { operation: "create-folder", name: "Work" } });
		const removed: SidebarResult = {
			operation: "delete-folder", deletedFolder: { id: "old", name: "Old", botIds: ["bot-1"] }, unassignedBotIds: ["bot-1"],
		};
		deleted.resolve(removed);
		await settle(() => socket.sent.some((frame) => frame.type === "sidebar.res" && frame.id === 2));
		expect(socket.sent.at(-1)).toEqual({ type: "sidebar.res", id: 2, ok: true, result: removed });
		const folder: SidebarResult = { operation: "create-folder", folder: { id: "new", name: "Work", botIds: [] } };
		created.resolve(folder);
		await settle(() => socket.sent.some((frame) => frame.type === "sidebar.res" && frame.id === 1));
		expect(socket.sent.at(-1)).toEqual({ type: "sidebar.res", id: 1, ok: true, result: folder });
		expect(operations).toEqual(["create-folder", "delete-folder"]);
		client.stop();
	});

	for (const action of ["disconnect", "move", "stop"] as const) {
		test(`a pending mutation reply is abandoned after ${action}, never sent through a replacement socket`, async () => {
			const { client, last, clock, sockets } = setup();
			const gate = Promise.withResolvers<SidebarResult>();
			let mutations = 0;
			client.onSidebarRequest((command) => {
				if (command.operation === "create-folder") {
					mutations++;
					return gate.promise;
				}
				return Promise.resolve({ operation: "list-folders", folders: [] });
			});
			client.start();
			const old = last();
			old.accept();
			old.welcome();
			old.receive({ type: "sidebar.req", id: 1, command: { operation: "create-folder", name: "Once" } });
			if (action === "disconnect") {
				old.drop();
				clock.advance(1_000);
			} else if (action === "move") {
				old.event("bridge.moving", { port: 39321 });
			} else {
				client.stop();
				clock.advance(60_000);
			}
			const replacement = action === "stop" ? null : last();
			if (replacement) {
				expect(replacement).not.toBe(old);
				replacement.accept();
				replacement.welcome();
				replacement.receive({ type: "sidebar.req", id: 2, command: { operation: "list-folders" } });
				await settle(() => replacement.sent.some((frame) => frame.type === "sidebar.res"));
			}
			gate.resolve({ operation: "create-folder", folder: { id: "once", name: "Once", botIds: [] } });
			await gate.promise;
			await Promise.resolve();
			old.receive({ type: "sidebar.req", id: 3, command: { operation: "create-folder", name: "Forged old request" } });
			expect(old.sent.filter((frame) => frame.type === "sidebar.res")).toEqual([]);
			expect(replacement?.sent.filter((frame) => frame.type === "sidebar.res")).toEqual(
				replacement ? [{ type: "sidebar.res", id: 2, ok: true, result: { operation: "list-folders", folders: [] } }] : undefined,
			);
			expect(mutations).toBe(1);
			expect(sockets).toHaveLength(action === "stop" ? 1 : 2);
			client.stop();
		});
	}

	test("two renderer clients execute only their own addressed commands", async () => {
		const windows = [setup(), setup()];
		for (const [index, window] of windows.entries()) {
			window.client.onSidebarRequest(async () => ({
				operation: "list-bots", bots: [{ id: `bot-${index}`, name: `Window ${index}`, folderId: null }],
			}));
			window.client.start();
			window.last().accept();
			window.last().welcome();
		}
		windows[1]?.last().receive({ type: "sidebar.req", id: 1, command: { operation: "list-bots" } });
		await settle(() => windows[1]?.last().sent.some((frame) => frame.type === "sidebar.res") === true);
		expect(windows[0]?.last().sent.filter((frame) => frame.type === "sidebar.res")).toEqual([]);
		expect(windows[1]?.last().sent.at(-1)).toEqual({
			type: "sidebar.res", id: 1, ok: true,
			result: { operation: "list-bots", bots: [{ id: "bot-1", name: "Window 1", folderId: null }] },
		});
		for (const window of windows) window.client.stop();
	});
});

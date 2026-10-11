import { describe, expect, test } from "bun:test";
import { BridgeRequestError, createBridgeClient, RECONNECT_MAX_MS, type BridgeClient } from "./bridge-client.ts";
import { createFakeSockets, FakeClock, fakeGlobals, recordingLogger } from "./test/fakes.ts";

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

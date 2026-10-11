import { describe, expect, test } from "bun:test";
import { createBridgeClient } from "./bridge-client.ts";
import { createServicesClient } from "./services.ts";
import { createFakeSockets, FakeClock, fakeGlobals, recordingLogger } from "./test/fakes.ts";

function setup() {
	const fake = createFakeSockets();
	const clock = new FakeClock();
	const log = recordingLogger();
	const bridge = createBridgeClient({
		port: 39320,
		token: "t",
		buildKey: "k",
		appVersion: "0.68.1",
		bgbVersion: "0.1.0",
		globals: fakeGlobals(fake.WebSocket),
		clock,
		log,
	});
	const services = createServicesClient(bridge, log);
	bridge.start();
	const socket = fake.last();
	socket.accept();
	socket.welcome();
	return { bridge, services, socket, clock, fake };
}

describe("services client", () => {
	test("keys.watch carries the window's union of watched codes", () => {
		const { services, socket } = setup();
		const ptt = services.keysFor("push-to-talk");
		const other = services.keysFor("other");
		const stopA = ptt.watch("AltRight", () => {});
		const stopB = other.watch("F5", () => {});
		other.watch("AltRight", () => {});
		expect(socket.requests("keys.watch").map((frame) => frame.params)).toEqual([{ codes: ["AltRight"] }, { codes: ["AltRight", "F5"] }]);
		stopB();
		stopA();
		expect(socket.lastRequest("keys.watch").params).toEqual({ codes: ["AltRight"] });
	});

	test("non-watchable codes are refused before they reach the agent", () => {
		const { services, socket } = setup();
		expect(() => services.keysFor("p").watch("KeyA", () => {})).toThrow(RangeError);
		expect(socket.requests("keys.watch")).toHaveLength(0);
	});

	test("key events reach the code's watchers; a disconnect releases held keys with false", () => {
		const { services, socket } = setup();
		const events: boolean[] = [];
		services.keysFor("push-to-talk").watch("AltRight", (down) => events.push(down));
		socket.event("keys.key", { code: "AltRight", down: true });
		socket.event("keys.key", { code: "F5", down: true });
		expect(events).toEqual([true]);
		socket.drop();
		expect(events).toEqual([true, false]);
		expect(services.keysFor("push-to-talk").state).toBe("error");
	});

	test("chords go to the plugins watching that code", () => {
		const { services, socket } = setup();
		const chordsA: string[] = [];
		const chordsB: string[] = [];
		services.keysFor("a").watch("AltRight", () => {});
		services.keysFor("a").onChord((code) => chordsA.push(code));
		services.keysFor("b").onChord((code) => chordsB.push(code));
		socket.event("keys.chord", { code: "AltRight" });
		expect(chordsA).toEqual(["AltRight"]);
		expect(chordsB).toEqual([]);
	});

	test("media.duck sends the minimum level across plugins; 1 releases", () => {
		const { services, socket } = setup();
		services.mediaFor("a").duck(0.5);
		services.mediaFor("b").duck(0.2);
		services.mediaFor("b").duck(1);
		services.mediaFor("a").duck(1);
		expect(socket.requests("media.duck").map((frame) => frame.params)).toEqual([{ level: 0.5 }, { level: 0.2 }, { level: 0.5 }, { level: 1 }]);
	});

	test("states follow status.get and state events", () => {
		const { services, socket } = setup();
		const keys = services.keysFor("p");
		let changes = 0;
		keys.subscribe(() => changes++);
		services.applyStatus({ keys: { state: "needs-install" }, media: { state: "needs-install" } });
		expect(keys.state).toBe("needs-install");
		socket.event("keys.state", { state: "needs-permission", detail: "Input Monitoring" });
		expect(keys.state).toBe("needs-permission");
		expect(keys.detail).toBe("Input Monitoring");
		expect(services.mediaFor("p").state).toBe("needs-install");
		expect(changes).toBe(2);
	});

	test("resync resends the union and level even when nothing changed", () => {
		const { services, socket } = setup();
		services.resync();
		expect(socket.lastRequest("keys.watch").params).toEqual({ codes: [] });
		expect(socket.lastRequest("media.duck").params).toEqual({ level: 1 });
	});
});

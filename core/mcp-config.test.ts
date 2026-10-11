import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { McpServerConfig } from "../sdk/index.ts";
import { BgbError } from "./errors.ts";
import { withLock } from "./lock.ts";
import { mutateMcpConfig, parseMcpArguments, parseMcpServerConfig, readMcpConfig } from "./mcp-config.ts";
import { type DataPaths, dataPaths, ensureDataDir } from "./paths.ts";

type StdioConfig = Extract<McpServerConfig, { transport: "stdio" }>;

let paths: DataPaths;
let file: string;

beforeEach(async () => {
	paths = dataPaths(await mkdtemp(path.join(tmpdir(), "bgb-mcp-config-")));
	await ensureDataDir(paths);
	file = path.join(paths.root, "mcp.json");
});

afterEach(async () => {
	await rm(paths.root, { recursive: true, force: true });
});

function stdio(id = "voice"): StdioConfig {
	return {
		id,
		name: "Voice tools",
		enabled: false,
		transport: "stdio",
		command: "voice-mcp",
		args: ["--stdio"],
		env: {},
	};
}

function remote(transport: "http" | "sse" = "http"): McpServerConfig {
	return {
		id: "remote",
		name: "Remote tools",
		enabled: false,
		transport,
		url: "https://example.test/mcp?token=kept-in-config",
		headers: { Authorization: "Bearer kept-in-config" },
	};
}

function badRequest(fn: () => unknown): BgbError {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(BgbError);
		if (!(error instanceof BgbError)) throw error;
		expect(error.code).toBe("bad-request");
		return error;
	}
	throw new Error("Expected a bad-request validation error");
}

async function failure(operation: () => Promise<unknown>): Promise<BgbError> {
	try {
		await operation();
	} catch (error) {
		expect(error).toBeInstanceOf(BgbError);
		if (!(error instanceof BgbError)) throw error;
		return error;
	}
	throw new Error("Expected an MCP persistence error");
}

test("server parsing defaults only an absent enabled field and preserves explicit opt-in", () => {
	const { enabled: _enabled, ...withoutEnabled } = stdio();
	expect(parseMcpServerConfig(withoutEnabled)).toEqual(stdio());
	expect(parseMcpServerConfig({ ...withoutEnabled, enabled: true }).enabled).toBe(true);
	expect(parseMcpServerConfig({ ...withoutEnabled, enabled: false }).enabled).toBe(false);
	for (const enabled of [undefined, null, "true", 1]) {
		expect(badRequest(() => parseMcpServerConfig({ ...withoutEnabled, enabled })).message).toContain("enabled");
	}
});

test("server parsing accepts complete stdio, HTTP, and SSE configurations without changing secrets", () => {
	const config = { ...stdio(), command: " /opt/voice tools/server ", args: ["", "two words", "秘密"], env: { TOKEN: "secret", _EMPTY: "" }, cwd: "/tmp/voice tools" };
	expect(parseMcpServerConfig(config)).toEqual(config);
	for (const transport of ["http", "sse"] as const) {
		expect(parseMcpServerConfig(remote(transport))).toEqual(remote(transport));
		expect(parseMcpServerConfig({ ...remote(transport), url: "http://localhost:8123/mcp", headers: {} }).transport).toBe(transport);
	}
});

test("server ids are safe complete matches, including the 64-character boundary", () => {
	for (const id of ["a", "0", "Voice_1-tools", "a".repeat(64)]) {
		expect(parseMcpServerConfig({ ...stdio(), id }).id).toBe(id);
	}
	for (const id of [undefined, null, 1, "", "a".repeat(65), "-voice", "_voice", "a.b", "../voice", "voice tools", "voice\n", "voice\r\n", "秘密", "voice\0"]) {
		expect(badRequest(() => parseMcpServerConfig({ ...stdio(), id })).message).toContain("id");
	}
});

test("server names and executable fields enforce their specified string requirements", () => {
	for (const name of [undefined, null, 1, "", " \t\n"]) {
		expect(badRequest(() => parseMcpServerConfig({ ...stdio(), name })).message).toContain("name");
	}
	for (const field of ["command", "cwd"] as const) {
		for (const value of [undefined, null, 1, "", " \t", "voice\0secret"]) {
			expect(badRequest(() => parseMcpServerConfig({ ...stdio(), [field]: value })).message).toContain(field);
		}
	}
	for (const args of [undefined, null, "--stdio", [1], ["bad\0arg"], Array(1)]) {
		expect(badRequest(() => parseMcpServerConfig({ ...stdio(), args })).message).toContain("args");
	}
	for (const env of [undefined, null, [], { TOKEN: 1 }, { TOKEN: "bad\0value" }, { "": "value" }, { "1TOKEN": "value" }, { "TOKEN=BAD": "value" }, { "TOKEN\n": "value" }]) {
		expect(badRequest(() => parseMcpServerConfig({ ...stdio(), env })).message).toContain("env");
	}
});

test("server parsing rejects unknown fields, unsupported transports, and non-data objects", () => {
	for (const value of [null, [], "server", new Date(), Object.create({ transport: "stdio" })]) {
		badRequest(() => parseMcpServerConfig(value));
	}
	for (const transport of [undefined, "websocket", "shell", 1]) {
		expect(badRequest(() => parseMcpServerConfig({ ...stdio(), transport })).message).toContain("transport");
	}
	for (const value of [{ ...stdio(), shell: true }, { ...stdio(), url: "https://example.test" }, { ...remote(), command: "voice" }, { ...remote(), env: {} }, { ...stdio(), toString: "hidden" }]) {
		expect(badRequest(() => parseMcpServerConfig(value)).message).toContain("unsupported");
	}
	badRequest(() => parseMcpServerConfig({ ...stdio(), [Symbol("hidden")]: "secret" }));
	let getterCalled = false;
	const accessor = { ...stdio() };
	Object.defineProperty(accessor, "command", { enumerable: true, get: () => { getterCalled = true; return "secret"; } });
	badRequest(() => parseMcpServerConfig(accessor));
	expect(getterCalled).toBe(false);
});

test("remote servers reject credentials, fragments, non-HTTP URLs, and invalid headers", () => {
	for (const url of [undefined, 1, "", "/mcp", "not-a-url", "file:///tmp/mcp", "ftp://example.test/mcp", "https://user:password@example.test/mcp", "https://user@example.test/mcp", "https://:password@example.test/mcp", "https://example.test/mcp#fragment", "https://example.test/mcp#"]) {
		expect(badRequest(() => parseMcpServerConfig({ ...remote(), url })).message).toContain("url");
	}
	for (const headers of [undefined, null, [], { Authorization: 1 }, { "Bad Header": "value" }, { "Bad\nHeader": "value" }, { Authorization: "Bearer secret\r\ninjected: value" }, { Authorization: "secret\0" }]) {
		expect(badRequest(() => parseMcpServerConfig({ ...remote(), headers })).message).toContain("headers");
	}
});

test("argument parsing accepts real bridge JSON and shared noncyclic JSON subtrees", () => {
	const args: unknown = JSON.parse('{"text":"秘密","nested":{"count":2,"ok":true,"empty":null},"items":[1,"two",false,null],"__proto__":{"safe":true}}');
	expect(args).toEqual(parseMcpArguments(args));
	const shared = { number: 1 };
	expect(parseMcpArguments({ first: shared, second: shared })).toEqual({ first: shared, second: shared });
	const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { nested: { valid: true } });
	expect(parseMcpArguments(nullPrototype)).toBe(nullPrototype);
});

test("argument parsing rejects values JSON would drop, coerce, or execute", () => {
	for (const value of [undefined, null, [], "text", 1, true, new Date(), new Map(), Object.create({ inherited: true })]) {
		badRequest(() => parseMcpArguments(value));
	}
	for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1n, Symbol("secret"), () => "secret", new Date(), new Map(), new Set(), new Number(1), Object.create({ inherited: true })]) {
		badRequest(() => parseMcpArguments({ nested: { value } }));
		badRequest(() => parseMcpArguments({ items: [value] }));
	}
	badRequest(() => parseMcpArguments({ items: Array(1) }));
	const decorated = [1];
	Object.defineProperty(decorated, "extra", { value: "secret", enumerable: true });
	badRequest(() => parseMcpArguments({ items: decorated }));
	badRequest(() => parseMcpArguments({ [Symbol("hidden")]: "secret" }));
	badRequest(() => parseMcpArguments(Object.defineProperty({}, "hidden", { value: "secret" })));
	let invoked = false;
	badRequest(() => parseMcpArguments({ toJSON: () => { invoked = true; return {}; } }));
	badRequest(() => parseMcpArguments({ get token() { invoked = true; return "secret"; } }));
	expect(invoked).toBe(false);
});

test("argument parsing rejects object, array, and indirect cycles without rejecting repeated values", () => {
	const direct: Record<string, unknown> = {};
	direct.self = direct;
	badRequest(() => parseMcpArguments(direct));
	const items: unknown[] = [];
	items.push(items);
	badRequest(() => parseMcpArguments({ items }));
	const outer: Record<string, unknown> = { inner: {} };
	(outer.inner as Record<string, unknown>).outer = outer;
	badRequest(() => parseMcpArguments(outer));
});

test("parser diagnostics contain fields, never raw values, unknown keys, URL credentials, or headers", () => {
	const secret = "DO_NOT_DISCLOSE_MCP_SECRET";
	const failures = [
		() => parseMcpServerConfig({ ...stdio(), command: `${secret}\0`, env: { TOKEN: secret } }),
		() => parseMcpServerConfig({ ...stdio(), env: { [`${secret}=`]: secret } }),
		() => parseMcpServerConfig({ ...stdio(), [secret]: secret }),
		() => parseMcpServerConfig({ ...remote(), url: `https://user:${secret}@example.test/mcp`, headers: { Authorization: secret } }),
		() => parseMcpServerConfig({ ...remote(), headers: { Authorization: `${secret}\ninjected` } }),
		() => parseMcpArguments({ [secret]: () => secret }),
		() => parseMcpArguments(new Proxy({}, { getPrototypeOf() { throw new Error(secret); } })),
	];
	for (const operation of failures) {
		const error = badRequest(operation);
		expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(secret);
		expect(error.data).toBeUndefined();
	}
});

test("reading absent MCP config is empty and does not create a file or acquire a config lock", async () => {
	expect(await readMcpConfig(paths)).toEqual([]);
	expect(existsSync(file)).toBe(false);
	await withLock(paths, "config", async () => {
		expect(await readMcpConfig(paths)).toEqual([]);
	});
	expect(existsSync(file)).toBe(false);
});

test("mutations persist version one with private mode, preserve enabled values, and leave no temp files", async () => {
	const { enabled: _enabled, ...disabledByDefault } = stdio("disabled");
	await writeFile(file, JSON.stringify({ version: 1, servers: [disabledByDefault] }), { mode: 0o644 });
	const next = await mutateMcpConfig(paths, (servers) => {
		servers.push({ ...stdio("enabled"), enabled: true });
	});
	expect(next).toEqual([stdio("disabled"), { ...stdio("enabled"), enabled: true }]);
	expect(await readMcpConfig(paths)).toEqual(next);
	const disk: unknown = JSON.parse(await readFile(file, "utf8"));
	expect(disk).toEqual({ version: 1, servers: next });
	if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
	expect((await readdir(paths.root)).filter((entry) => entry.startsWith("mcp.json.tmp-"))).toEqual([]);
	expect(existsSync(path.join(paths.locks, "config.lock"))).toBe(false);
});

test("mutations create missing config and read every external edit freshly", async () => {
	expect(await mutateMcpConfig(paths, (servers) => { servers.push(stdio("initial")); })).toEqual([stdio("initial")]);
	await writeFile(file, JSON.stringify({ version: 1, servers: [stdio("external")] }));
	expect(await mutateMcpConfig(paths, (servers) => { servers.push(stdio("added")); })).toEqual([stdio("external"), stdio("added")]);
	expect(await mutateMcpConfig(paths, (servers) => { servers.splice(0, servers.length); })).toEqual([]);
	expect(await readMcpConfig(paths)).toEqual([]);
});

test("malformed and invalid documents reject reads and mutations without overwriting bytes", async () => {
	const invalid = [
		'{"version":1,"servers":[],"token":"DO_NOT_DISCLOSE_FILE_SECRET",',
		JSON.stringify(null),
		JSON.stringify([]),
		JSON.stringify({ version: 2, servers: [] }),
		JSON.stringify({ servers: [] }),
		JSON.stringify({ version: 1, servers: {} }),
		JSON.stringify({ version: 1, servers: [null] }),
		JSON.stringify({ version: 1, servers: [{ ...stdio(), env: { TOKEN: "secret\0" } }] }),
		JSON.stringify({ version: 1, servers: [stdio(), stdio()] }),
		JSON.stringify({ version: 1, servers: [], hidden: "secret" }),
	];
	for (const contents of invalid) {
		await writeFile(file, contents);
		const readError = await failure(() => readMcpConfig(paths));
		expect(readError.code).toBe("unavailable");
		let callbackRan = false;
		const mutateError = await failure(() => mutateMcpConfig(paths, () => { callbackRan = true; }));
		expect(mutateError.code).toBe("unavailable");
		expect(callbackRan).toBe(false);
		expect(await readFile(file, "utf8")).toBe(contents);
		for (const error of [readError, mutateError]) {
			expect(`${String(error)}${JSON.stringify(error)}`).not.toContain("DO_NOT_DISCLOSE_FILE_SECRET");
			expect(error.data).toBeUndefined();
		}
	}
});

test("invalid mutations preserve the old file and release the config lock", async () => {
	await mutateMcpConfig(paths, (servers) => { servers.push(stdio()); });
	const before = await readFile(file, "utf8");
	for (const mutation of [
		(servers: McpServerConfig[]) => { servers.push(stdio()); },
		(servers: McpServerConfig[]) => { servers.push({ ...stdio("bad"), name: " " }); },
		(servers: McpServerConfig[]) => { servers.push({ ...stdio("bad"), command: "secret\0" }); },
	]) {
		const error = await failure(() => mutateMcpConfig(paths, mutation));
		expect(error.code).toBe("bad-request");
		expect(await readFile(file, "utf8")).toBe(before);
		expect(existsSync(path.join(paths.locks, "config.lock"))).toBe(false);
	}
	await mutateMcpConfig(paths, (servers) => { servers.push(stdio("healthy")); });
	expect((await readMcpConfig(paths)).map((server) => server.id)).toEqual(["voice", "healthy"]);
});

test("trusted callback bridge errors survive while unexpected callback errors are sanitized", async () => {
	await mutateMcpConfig(paths, (servers) => { servers.push(stdio()); });
	const before = await readFile(file, "utf8");
	const missing = new BgbError("not-found", "MCP server not found");
	expect(await failure(() => mutateMcpConfig(paths, () => { throw missing; }))).toBe(missing);
	const error = await failure(() => mutateMcpConfig(paths, () => { throw new Error("DO_NOT_DISCLOSE_CALLBACK_SECRET"); }));
	expect(error.code).toBe("unavailable");
	expect(error.message).not.toContain("DO_NOT_DISCLOSE_CALLBACK_SECRET");
	expect(await readFile(file, "utf8")).toBe(before);
	expect(existsSync(path.join(paths.locks, "config.lock"))).toBe(false);
});

test("concurrent in-process mutations keep every update across independently created DataPaths", async () => {
	await Promise.all(Array.from({ length: 16 }, (_, index) =>
		mutateMcpConfig(dataPaths(paths.root), (servers) => { servers.push(stdio(`server-${index}`)); }),
	));
	const ids = (await readMcpConfig(paths)).map((server) => server.id).sort();
	expect(ids).toEqual(Array.from({ length: 16 }, (_, index) => `server-${index}`).sort());
});

test("cross-process and in-process mutations share the config lock and retain all updates", async () => {
	const script = path.join(paths.root, "mutator.ts");
	await writeFile(script, `import { mutateMcpConfig } from ${JSON.stringify(path.join(import.meta.dir, "mcp-config.ts"))};
import { dataPaths } from ${JSON.stringify(path.join(import.meta.dir, "paths.ts"))};
const [root, prefix] = process.argv.slice(2) as [string, string];
process.stdout.write("ready\\n");
await new Response(Bun.stdin.stream()).text();
for (let index = 0; index < 6; index++) {
	await mutateMcpConfig(dataPaths(root), (servers) => {
		servers.push({ id: prefix + "-" + index, name: "Child tools", enabled: false, transport: "stdio", command: "voice-mcp", args: [], env: {} });
	});
}
`);
	const prefixes = ["child-a", "child-b", "child-c"];
	const children = prefixes.map((prefix) => Bun.spawn([process.execPath, script, paths.root, prefix], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	}));
	// Every child is initialized and waiting on stdin EOF before any mutation starts.
	await Promise.all(children.map(async (child) => {
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let output = "";
		try {
			while (!output.includes("\n")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("MCP mutation child exited before readiness");
				output += decoder.decode(chunk.value, { stream: true });
			}
			expect(output).toBe("ready\n");
		} finally {
			reader.releaseLock();
		}
	}));
	for (const child of children) child.stdin.end();
	const outcomes = Promise.all(children.map(async (child) => ({
		code: await child.exited,
		stderr: await new Response(child.stderr).text(),
	})));
	await Promise.all(Array.from({ length: 6 }, (_, index) =>
		mutateMcpConfig(paths, (servers) => { servers.push(stdio(`parent-${index}`)); }),
	));
	for (const outcome of await outcomes) expect(outcome).toEqual({ code: 0, stderr: "" });
	const expected = [...prefixes, "parent"].flatMap((prefix) => Array.from({ length: 6 }, (_, index) => `${prefix}-${index}`)).sort();
	expect((await readMcpConfig(paths)).map((server) => server.id).sort()).toEqual(expected);
	if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
}, 60_000);

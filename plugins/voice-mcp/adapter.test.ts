import { describe, expect, test } from "bun:test";
import type { McpTool, McpToolResult } from "../../sdk/index.ts";
import { createVoiceAdapter } from "./adapter.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function tool(serverId = "alpha", name = "lookup"): McpTool {
	return {
		serverId,
		name,
		description: `Lookup on ${serverId}`,
		inputSchema: { type: "object", properties: { query: { type: "string" } } },
	};
}

function preparedName(tools: unknown[], index = 0): string {
	const value = tools[index] as { name: string };
	return value.name;
}

const success: McpToolResult = { content: [{ type: "text", text: "found" }] };

function fixture(initialTools: McpTool[] = [tool()]) {
	let available = initialTools;
	let execute = async (_serverId: string, _name: string, _args: Record<string, unknown>): Promise<McpToolResult> => success;
	const calls: { serverId: string; name: string; args: Record<string, unknown> }[] = [];
	const reports: unknown[] = [];
	const adapter = createVoiceAdapter({
		tools: async () => available,
		call: async (serverId, name, args) => {
			calls.push({ serverId, name, args });
			return execute(serverId, name, args);
		},
	}, (error) => reports.push(error));
	return {
		adapter, calls, reports,
		setTools: (next: McpTool[]) => { available = next; },
		setExecute: (next: typeof execute) => { execute = next; },
	};
}

function expectError(output: McpToolResult | undefined) {
	expect(output?.isError).toBe(true);
	expect(output?.content).toEqual(expect.arrayContaining([
		expect.objectContaining({ type: "text", text: expect.any(String) }),
	]));
}

describe("voice MCP adapter", () => {
	test("prepare awaits discovery and leaves native tools unchanged", async () => {
		const discovery = deferred<McpTool[]>();
		const adapter = createVoiceAdapter({ tools: () => discovery.promise, call: async () => success });
		const native = [{ type: "function", name: "native_lookup" }];
		let settled = false;
		const preparation = adapter.prepare(native).then((value) => { settled = true; return value; });
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(native).toEqual([{ type: "function", name: "native_lookup" }]);
		const discovered = tool();
		discovery.resolve([discovered]);
		const prepared = await preparation;
		expect(prepared).not.toBe(native);
		expect(prepared[0]).toBe(native[0]);
		expect(native).toHaveLength(1);
		expect(prepared).toHaveLength(2);
		expect(prepared[1]).toEqual({
			type: "function", name: expect.stringMatching(/^bgb_mcp_.+/),
			description: `MCP server ${discovered.serverId}, tool ${discovered.name}. ${discovered.description}`, parameters: discovered.inputSchema,
		});
	});

	test("distinct servers map identical tool names separately and sessions retain their discovery snapshots", async () => {
		const f = fixture([tool("alpha"), tool("beta")]);
		const first = await f.adapter.prepare([]);
		const alpha = preparedName(first);
		const beta = preparedName(first, 1);
		expect(alpha).not.toBe(beta);
		f.setTools([tool("gamma", "search")]);
		const second = await f.adapter.prepare([]);
		expect(second).toHaveLength(1);
		const sent: McpToolResult[] = [];
		for (const [callId, name] of [["a", alpha], ["b", beta]]) {
			expect(await f.adapter.dispatch({ callId: callId!, name: name!, argumentsJson: '{"query":"old"}' }, { args: { tools: first } }, () => true, (output) => sent.push(output))).toBe(true);
		}
		expect(await f.adapter.dispatch({ callId: "c", name: preparedName(second), argumentsJson: "{}" }, { args: { tools: second } }, () => true, (output) => sent.push(output))).toBe(true);
		expect(f.calls).toEqual([
			{ serverId: "alpha", name: "lookup", args: { query: "old" } },
			{ serverId: "beta", name: "lookup", args: { query: "old" } },
			{ serverId: "gamma", name: "search", args: {} },
		]);
		expect(sent).toEqual([success, success, success]);
	});

	test("native and forged namespace names fall back without host calls or output", async () => {
		const f = fixture();
		const tools = await f.adapter.prepare([{ type: "function", name: "native_tool" }]);
		const sent: McpToolResult[] = [];
		for (const name of ["native_tool", "unknown", "bgb_mcp_forged_identity"]) {
			expect(await f.adapter.dispatch({ callId: name, name, argumentsJson: "{}" }, { args: { tools } }, () => true, (output) => sent.push(output))).toBe(false);
		}
		expect(f.calls).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("concurrent and resolved duplicate call IDs execute and send only once per session", async () => {
		const f = fixture();
		const result = deferred<McpToolResult>();
		f.setExecute(() => result.promise);
		const tools = await f.adapter.prepare([]);
		const session = { args: { tools } };
		const call = { callId: "duplicate", name: preparedName(tools), argumentsJson: "{}" };
		const sent: McpToolResult[] = [];
		const send = (output: McpToolResult) => sent.push(output);
		const first = f.adapter.dispatch(call, session, () => true, send);
		const duplicate = f.adapter.dispatch(call, session, () => true, send);
		await Promise.resolve();
		expect(f.calls).toHaveLength(1);
		result.resolve(success);
		expect(await first).toBe(true);
		expect(await duplicate).toBe(true);
		expect(await f.adapter.dispatch(call, session, () => true, send)).toBe(true);
		expect(f.calls).toHaveLength(1);
		expect(sent).toEqual([success]);
	});

	test("already stale sessions skip execution and output", async () => {
		const f = fixture();
		const tools = await f.adapter.prepare([]);
		const sent: McpToolResult[] = [];
		expect(await f.adapter.dispatch({ callId: "stale", name: preparedName(tools), argumentsJson: "{}" }, { args: { tools } }, () => false, (output) => sent.push(output))).toBe(true);
		expect(f.calls).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("late results are suppressed while a new session can reuse the same call ID", async () => {
		const f = fixture();
		const result = deferred<McpToolResult>();
		f.setExecute(() => result.promise);
		const tools = await f.adapter.prepare([]);
		const call = { callId: "reused", name: preparedName(tools), argumentsJson: "{}" };
		let current = true;
		const oldOutput: McpToolResult[] = [];
		const pending = f.adapter.dispatch(call, { args: { tools } }, () => current, (output) => oldOutput.push(output));
		current = false;
		const newOutput: McpToolResult[] = [];
		f.setExecute(async () => success);
		expect(await f.adapter.dispatch(call, { args: { tools } }, () => true, (output) => newOutput.push(output))).toBe(true);
		result.resolve(success);
		expect(await pending).toBe(true);
		expect(f.calls).toHaveLength(2);
		expect(oldOutput).toEqual([]);
		expect(newOutput).toEqual([success]);
	});

	for (const argumentsJson of ["{", "null", "[]", '"string"', "42", "true"]) {
		test(`invalid object arguments ${argumentsJson} return an honest error without execution`, async () => {
			const f = fixture();
			const tools = await f.adapter.prepare([]);
			const sent: McpToolResult[] = [];
			expect(await f.adapter.dispatch({ callId: "invalid", name: preparedName(tools), argumentsJson }, { args: { tools } }, () => true, (output) => sent.push(output))).toBe(true);
			expect(f.calls).toEqual([]);
			expect(sent).toHaveLength(1);
			expectError(sent[0]);
		});
	}

	for (const completed of [false, true]) {
		test(`reconnect shares ${completed ? "completed" : "in-flight"} execution and delivers once to the current session`, async () => {
			const f = fixture();
			const result = deferred<McpToolResult>();
			f.setExecute(() => result.promise);
			const tools = await f.adapter.prepare([]);
			const scope = {};
			const oldSession = { args: { tools } };
			const newSession = { args: { tools } };
			const call = { callId: "reconnect", name: preparedName(tools), argumentsJson: "{}" };
			let oldCurrent = true;
			const oldOutput: McpToolResult[] = [];
			const newOutput: McpToolResult[] = [];
			const first = f.adapter.dispatch(call, oldSession, () => oldCurrent, (output) => oldOutput.push(output), scope);
			if (completed) {
				result.resolve(success);
				expect(await first).toBe(true);
			}
			oldCurrent = false;
			const reconnect = f.adapter.dispatch(call, newSession, () => true, (output) => newOutput.push(output), scope);
			const duplicate = f.adapter.dispatch(call, newSession, () => true, (output) => newOutput.push(output), scope);
			result.resolve(success);
			expect(await first).toBe(true);
			expect(await reconnect).toBe(true);
			expect(await duplicate).toBe(true);
			expect(f.calls).toHaveLength(1);
			expect(oldOutput).toEqual(completed ? [success] : []);
			expect(newOutput).toEqual([success]);
		});
	}

	for (const conflict of ["tool", "arguments"] as const) {
		test(`reused call ID with changed ${conflict} does not execute or replay success`, async () => {
			const f = fixture([tool("alpha"), tool("beta")]);
			const tools = await f.adapter.prepare([]);
			const scope = {};
			const call = { callId: "immutable", name: preparedName(tools), argumentsJson: '{"query":"first"}' };
			const firstOutput: McpToolResult[] = [];
			expect(await f.adapter.dispatch(call, { args: { tools } }, () => true, (output) => firstOutput.push(output), scope)).toBe(true);
			const changed = {
				...call,
				name: conflict === "tool" ? preparedName(tools, 1) : call.name,
				argumentsJson: conflict === "arguments" ? '{"query":"changed"}' : call.argumentsJson,
			};
			const conflictOutput: McpToolResult[] = [];
			expect(await f.adapter.dispatch(changed, { args: { tools } }, () => true, (output) => conflictOutput.push(output), scope)).toBe(true);
			expect(f.calls).toHaveLength(1);
			expect(firstOutput).toEqual([success]);
			expect(conflictOutput).toHaveLength(1);
			expectError(conflictOutput[0]);
		});
	}

	test("capture preserves native call identity and leaves native dispatch to its fallback", async () => {
		const f = fixture();
		const tools = await f.adapter.prepare([{ type: "function", name: "native_tool" }]);
		const call = { callId: "native", name: "native_tool", argumentsJson: "{}" };
		expect(f.adapter.capture(call, undefined)).toBe(call);
		expect(call).toEqual({ callId: "native", name: "native_tool", argumentsJson: "{}" });
		const sent: McpToolResult[] = [];
		expect(await f.adapter.dispatch(call, { args: { tools } }, () => true, (output) => sent.push(output))).toBe(false);
		expect(f.calls).toEqual([]);
		expect(sent).toEqual([]);
	});

	for (const rawArguments of [undefined, null, {}, [], 42, true]) {
		test(`captured non-string native arguments ${String(rawArguments)} reject coerced empty JSON`, async () => {
			const f = fixture();
			const tools = await f.adapter.prepare([]);
			const call = { callId: "captured", name: preparedName(tools), argumentsJson: "{}" };
			expect(f.adapter.capture(call, rawArguments)).toBe(call);
			const sent: McpToolResult[] = [];
			expect(await f.adapter.dispatch(call, { args: { tools } }, () => true, (output) => sent.push(output))).toBe(true);
			expect(f.calls).toEqual([]);
			expect(sent).toHaveLength(1);
			expectError(sent[0]);
		});
	}

	test("captured string JSON executes with the original object arguments", async () => {
		const f = fixture();
		const tools = await f.adapter.prepare([]);
		const call = { callId: "captured-valid", name: preparedName(tools), argumentsJson: "{}" };
		expect(f.adapter.capture(call, '{"query":"original"}')).toBe(call);
		const sent: McpToolResult[] = [];
		expect(await f.adapter.dispatch(call, { args: { tools } }, () => true, (output) => sent.push(output))).toBe(true);
		expect(f.calls).toEqual([{ serverId: "alpha", name: "lookup", args: { query: "original" } }]);
		expect(sent).toEqual([success]);
	});

	test("host rejection is reported as an error result, not successful empty content", async () => {
		const f = fixture();
		const error = new Error("MCP server unavailable");
		f.setExecute(async () => { throw error; });
		const tools = await f.adapter.prepare([]);
		const sent: McpToolResult[] = [];
		expect(await f.adapter.dispatch({ callId: "failure", name: preparedName(tools), argumentsJson: "{}" }, { args: { tools } }, () => true, (output) => sent.push(output))).toBe(true);
		expect(f.calls).toHaveLength(1);
		expect(sent).toHaveLength(1);
		expectError(sent[0]);
		expect(JSON.stringify(sent[0]?.content)).toContain("MCP server unavailable");
	});
});

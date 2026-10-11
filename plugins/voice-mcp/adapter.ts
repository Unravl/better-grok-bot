import type { McpTool, McpToolResult } from "@better-grok-bot/sdk";

interface ToolService {
	tools(): Promise<McpTool[]>;
	call(serverId: string, name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

interface VoiceToolCall {
	callId: string;
	name: string;
	argumentsJson: string;
}

interface VoiceSession {
	args: { tools: unknown[] };
}

/** Per-dial tool snapshots keep delayed/reconnected calls bound to the schemas actually advertised. */
export function createVoiceAdapter(service: ToolService, report: (error: unknown) => void = () => {}) {
	const snapshots = new WeakMap<unknown[], Map<string, McpTool>>();
	const encoder = new TextEncoder();
	const rawArguments = new WeakMap<VoiceToolCall, unknown>();
	function capture(call: VoiceToolCall, args: unknown): VoiceToolCall {
		rawArguments.set(call, args);
		return call;
	}
	const calls = new WeakMap<object, Map<string, { identity: string; arguments: unknown; result: Promise<McpToolResult>; delivered: WeakSet<VoiceSession> }>>();

	async function prepare(nativeTools: unknown[]): Promise<unknown[]> {
		try {
			const tools = await service.tools();
			const names = new Set(nativeTools.flatMap((tool) => {
				if (typeof tool !== "object" || tool === null || !("name" in tool) || typeof tool.name !== "string") return [];
				return [tool.name];
			}));
			const mapping = new Map<string, McpTool>();
			const added: unknown[] = [];
			const sorted = tools.toSorted((a, b) => {
				if (a.serverId !== b.serverId) return a.serverId < b.serverId ? -1 : 1;
				return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
			});
			const identities = new Set<string>();
			for (const tool of sorted) {
				const identity = JSON.stringify([tool.serverId, tool.name]);
				if (identities.has(identity)) continue;
				identities.add(identity);
				let name: string;
				let salt = 0;
				do {
					const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify([identity, salt++])));
					let hash = "";
					for (const byte of new Uint8Array(digest, 0, 28)) hash += byte.toString(16).padStart(2, "0");
					name = `bgb_mcp_${hash}`;
				} while (names.has(name));
				names.add(name);
				mapping.set(name, tool);
				added.push({
					type: "function",
					name,
					description: `MCP server ${tool.serverId}, tool ${tool.name}.${tool.description ? ` ${tool.description}` : ""}`,
					parameters: tool.inputSchema,
				});
			}
			const merged = [...nativeTools, ...added];
			snapshots.set(merged, mapping);
			return merged;
		} catch (error) {
			// An unavailable MCP bridge/server must not take native voice offline.
			report(error);
			return nativeTools;
		}
	}

	async function dispatch(call: VoiceToolCall, session: VoiceSession, isCurrent: () => boolean, send: (output: McpToolResult) => void, scope: object = session): Promise<boolean> {
		const tool = snapshots.get(session.args.tools)?.get(call.name);
		if (tool === undefined) return false;
		if (!isCurrent()) return true;
		let seen = calls.get(scope);
		if (seen === undefined) {
			seen = new Map();
			calls.set(scope, seen);
		}
		let record = seen.get(call.callId);
		const identity = JSON.stringify([tool.serverId, tool.name]);
		const source = rawArguments.has(call) ? rawArguments.get(call) : call.argumentsJson;
		if (record !== undefined && (record.identity !== identity || record.arguments !== source)) {
			const error = "MCP call ID was reused with a different tool or arguments; refusing to execute or replay a mismatched result.";
			if (!record.delivered.has(session)) {
				record.delivered.add(session);
				send({ isError: true, content: [{ type: "text", text: error }] });
			} else {
				// The original call already continued the model; don't continue that session twice.
				report(new Error(error));
			}
			return true;
		}
		if (record === undefined) {
			// Reserve before starting async execution. The native call object is shared by reconnects;
			// independent calls use separate scopes even if a provider reuses an ID.
			let resolve!: (result: McpToolResult) => void;
			record = { identity, arguments: source, result: new Promise<McpToolResult>((settle) => { resolve = settle; }), delivered: new WeakSet() };
			seen.set(call.callId, record);
			void (async () => {
				let result: McpToolResult;
				try {
					if (typeof source !== "string") throw new Error("Completed MCP tool arguments must be a JSON string.");
					const args: unknown = JSON.parse(source);
					if (typeof args !== "object" || args === null || Array.isArray(args)) {
						result = { isError: true, content: [{ type: "text", text: "MCP tool arguments must be a JSON object." }] };
					} else {
						result = await service.call(tool.serverId, tool.name, args as Record<string, unknown>);
					}
				} catch (error) {
					result = { isError: true, content: [{ type: "text", text: `MCP tool failed: ${error instanceof Error ? error.message : String(error)}` }] };
				}
				resolve(result);
			})();
		}
		const result = await record.result;
		// A re-emitted ID on a live replacement session may receive its cached result, never execute
		// again. Late results are not sent through the dead session; each live session receives once.
		if (isCurrent() && !record.delivered.has(session)) {
			record.delivered.add(session);
			send(result);
		}
		return true;
	}

	return { prepare, capture, dispatch };
}

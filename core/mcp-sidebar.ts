import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BGB_RENDERER_META_KEY, BGB_SIDEBAR_MCP_ID, isSidebarResult, SidebarError } from "../sdk/sidebar.ts";
import type { SidebarCommand, SidebarResult } from "../sdk/sidebar.ts";
import { connectBridge } from "./bridge/client.ts";
import type { BridgeClient } from "./bridge/client.ts";
import { BgbError } from "./errors.ts";
import type { DataPaths } from "./paths.ts";
import { BGB_VERSION } from "./version.ts";

export interface SidebarMcpOptions {
	/** Injectable connection boundary; called only on an actual tool invocation. */
	connect?: () => Promise<BridgeClient>;
}

function acknowledgement(result: SidebarResult): string {
	switch (result.operation) {
		case "list-bots": return `Found ${result.bots.length} bots. IDs are preferred; names must match uniquely.\n${JSON.stringify(result.bots)}`;
		case "list-folders": return `Found ${result.folders.length} folders. IDs are preferred; names must match uniquely.\n${JSON.stringify(result.folders)}`;
		case "create-folder": return `Created folder ${JSON.stringify(result.folder.name)} (${result.folder.id}).`;
		case "delete-folder": return `Deleted folder ${JSON.stringify(result.deletedFolder.name)} (${result.deletedFolder.id}); preserved every bot. ${result.unassignedBotIds.length} bots are now Unassigned.`;
		case "move-bot": return `Moved bot ${JSON.stringify(result.bot.name)} (${result.bot.id}) to ${result.bot.folderId === null ? "Unassigned" : `folder ${result.bot.folderId}`}.`;
	}
}

/** Official SDK server; construction and tools/list never contact or start the app or agent. */
export function createSidebarMcpServer(paths: DataPaths, options: SidebarMcpOptions = {}): McpServer {
	const server = new McpServer({ name: BGB_SIDEBAR_MCP_ID, version: BGB_VERSION });
	let connection: Promise<BridgeClient> | undefined;
	let stopped = false;
	const connect = options.connect ?? (() => connectBridge(paths));
	const closeBridge = (): void => {
		stopped = true;
		const pending = connection;
		connection = undefined;
		void pending?.then((client) => client.close(), () => {});
	};
	server.server.onclose = closeBridge;
	const invoke = async (command: SidebarCommand, meta: Record<string, unknown> | undefined): Promise<CallToolResult> => {
		try {
			const rendererConnectionId = meta?.[BGB_RENDERER_META_KEY];
			if (rendererConnectionId !== undefined && (typeof rendererConnectionId !== "number" || !Number.isSafeInteger(rendererConnectionId) || rendererConnectionId <= 0)) {
				throw new SidebarError("bad-request", "Renderer routing metadata must be a positive integer");
			}
			if (stopped) throw new SidebarError("unavailable", "MCP server has disconnected");
			if (!connection) {
				const pending = connect();
				connection = pending;
				void pending.then((client) => {
					if (stopped) client.close();
					client.onClose(() => { if (connection === pending) connection = undefined; });
				}, () => { if (connection === pending) connection = undefined; });
			}
			const client = await connection;
			if (stopped) throw new SidebarError("unavailable", "MCP server has disconnected");
			const result: unknown = await client.request("sidebar.execute", {
				command,
				...(typeof rendererConnectionId === "number" ? { rendererConnectionId } : {}),
			});
			if (!isSidebarResult(result) || result.operation !== command.operation) throw new SidebarError("internal", "Invalid sidebar bridge response");
			return { content: [{ type: "text", text: acknowledgement(result) }], structuredContent: { ...result } };
		} catch (error) {
			const known = error instanceof SidebarError || error instanceof BgbError;
			const failure = {
				code: known ? error.code : "internal",
				message: error instanceof Error ? error.message : "Sidebar operation failed",
				...(known && error.data !== undefined ? { data: error.data } : {}),
			};
			return { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }], structuredContent: { error: failure } };
		}
	};
	const selector = z.string().min(1).describe("Exact bot/folder ID preferred, otherwise unique exact case-insensitive name. Ambiguous names fail with candidates; no fuzzy matching.");
	const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
	const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
	server.registerTool("bgb_list_bots", {
		description: "List sidebar bots with stable IDs, names, and current folder IDs (null means Unassigned). Use IDs to avoid name ambiguity.",
		inputSchema: z.object({}).strict(), annotations: readAnnotations,
	}, (_args, extra) => invoke({ operation: "list-bots" }, extra._meta));
	server.registerTool("bgb_list_folders", {
		description: "List real sidebar folders with stable IDs, names, and contained bot IDs. Unassigned is not a deletable folder. Use IDs to avoid name ambiguity.",
		inputSchema: z.object({}).strict(), annotations: readAnnotations,
	}, (_args, extra) => invoke({ operation: "list-folders" }, extra._meta));
	server.registerTool("bgb_move_bot", {
		description: "Move an existing bot into an existing folder, or null for Unassigned. Never deletes or renames a bot. Prefer IDs; ambiguous exact names fail with candidates.",
		inputSchema: z.object({ bot: selector, folder: selector.nullable().describe("Destination folder ID or unique exact name; null moves to Unassigned.") }).strict(),
		annotations: { ...writeAnnotations, idempotentHint: true },
	}, (args, extra) => invoke({ operation: "move-bot", ...args }, extra._meta));
	server.registerTool("bgb_create_folder", {
		description: "Create a sidebar folder. Blank or duplicate normalized names fail; no bots are created or changed.",
		inputSchema: z.object({ name: z.string().min(1) }).strict(), annotations: writeAnnotations,
	}, (args, extra) => invoke({ operation: "create-folder", ...args }, extra._meta));
	server.registerTool("bgb_delete_folder", {
		description: "Delete only the named sidebar folder container, preserving every bot. Bots outside all remaining folders become Unassigned. Default/Unassigned folders cannot be deleted. Prefer IDs; ambiguous exact names fail with candidates.",
		inputSchema: z.object({ folder: selector }).strict(), annotations: { ...writeAnnotations, destructiveHint: true },
	}, (args, extra) => invoke({ operation: "delete-folder", ...args }, extra._meta));
	return server;
}

/** Resolves only when stdio ends or the client disconnects; diagnostics never use stdout. */
export async function serveSidebarMcp(paths: DataPaths): Promise<void> {
	const server = createSidebarMcpServer(paths);
	const done = Promise.withResolvers<void>();
	const onclose = server.server.onclose;
	server.server.onclose = () => { onclose?.(); done.resolve(); };
	const shutdown = (): void => { void server.close().then(done.resolve, done.reject); };
	process.stdin.once("end", shutdown);
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	try {
		await server.connect(new StdioServerTransport());
		await done.promise;
	} finally {
		process.stdin.off("end", shutdown);
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
		await server.close();
	}
}

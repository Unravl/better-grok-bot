import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "bun:test";
import { BGB_RENDERER_META_KEY } from "../sdk/sidebar.ts";
import { fakePlatform, tempContext } from "./agent/testing.ts";
import { mutateConfig } from "./config.ts";
import { BgbError } from "./errors.ts";
import { createSidebarMcpServer } from "./mcp-sidebar.ts";

test("SDK tools enforce finite schemas, preserve structured errors, and connect lazily per future call", async () => {
	const ctx = await tempContext(fakePlatform("linux"));
	let connects = 0;
	const server = createSidebarMcpServer(ctx.paths, { connect: async () => {
		connects++;
		throw new BgbError("conflict", "Multiple ready renderers", { candidates: [7, 9] });
	} });
	const client = new Client({ name: "sidebar-test", version: "1" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const tools = (await client.listTools()).tools;
		expect(tools.map((tool) => tool.name).sort()).toEqual(["bgb_create_folder", "bgb_delete_folder", "bgb_list_bots", "bgb_list_folders", "bgb_move_bot"]);
		expect(connects).toBe(0);
		expect(tools.find((tool) => tool.name === "bgb_delete_folder")?.annotations?.destructiveHint).toBe(true);
		expect(tools.find((tool) => tool.name === "bgb_list_bots")?.annotations?.readOnlyHint).toBe(true);
		const invalid = await client.callTool({ name: "bgb_move_bot", arguments: { bot: "a", folder: null, rendererConnectionId: 7 } });
		expect(invalid.isError).toBe(true);
		expect(connects).toBe(0);
		const metadata = await client.callTool({ name: "bgb_list_bots", arguments: {}, _meta: { [BGB_RENDERER_META_KEY]: 0 } });
		expect(metadata.isError).toBe(true);
		expect(metadata.structuredContent).toEqual({ error: { code: "bad-request", message: "Renderer routing metadata must be a positive integer" } });
		expect(connects).toBe(0);
		for (let index = 0; index < 2; index++) {
			const failed = await client.callTool({ name: "bgb_list_bots", arguments: {} });
			expect(failed.isError).toBe(true);
			expect(failed.structuredContent).toEqual({ error: { code: "conflict", message: "Multiple ready renderers", data: { candidates: [7, 9] } } });
		}
		expect(connects).toBe(2);
	} finally {
		await client.close();
		await server.close();
		await ctx.cleanup();
	}
});

test("actual CLI stdio initializes and lists tools with no live bridge", async () => {
	const ctx = await tempContext(fakePlatform("linux"));
	// Hold an owned ephemeral port throughout the call; never touch a real agent's default port.
	const failurePeer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Owned test failure", { status: 503 }) });
	const client = new Client({ name: "stdio-sidebar-test", version: "1" });
	const transport = new StdioClientTransport({ command: process.execPath, args: ["core/cli.ts", "--data-dir", ctx.paths.root, "mcp", "sidebar-folders"], stderr: "pipe" });
	try {
		const port = failurePeer.port;
		if (port === undefined) throw new Error("Expected owned TCP fixture");
		await mutateConfig(ctx.paths, (config) => { config.bridgePort = port; });
		await client.connect(transport);
		expect((await client.listTools()).tools).toHaveLength(5);
		const failed = await client.callTool({ name: "bgb_list_folders", arguments: {} });
		expect(failed.isError).toBe(true);
		expect(failed.structuredContent).toMatchObject({ error: { code: "unavailable" } });
	} finally {
		await client.close();
		await failurePeer.stop(true);
		await ctx.cleanup();
	}
});

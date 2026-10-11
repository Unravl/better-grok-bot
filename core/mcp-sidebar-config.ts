import type { McpServerConfig } from "../sdk/mcp.ts";
import { BGB_SIDEBAR_MCP_ID } from "../sdk/sidebar.ts";
import { installedBinary } from "./commands/env.ts";
import type { CoreContext } from "./context.ts";
import { mutateMcpConfig } from "./mcp-config.ts";

/** The installed executable, never `bun run` (which writes command chatter to stdout). */
export function sidebarMcpConfig(ctx: CoreContext): McpServerConfig {
	return {
		id: BGB_SIDEBAR_MCP_ID,
		name: "BGB Sidebar Folders",
		enabled: false,
		transport: "stdio",
		command: installedBinary(ctx),
		args: ["--data-dir", ctx.paths.root, "mcp", "sidebar-folders"],
		env: {},
	};
}

/** Only this exact local preset may receive host-authored renderer routing metadata. */
export function isManagedSidebarMcpConfig(ctx: CoreContext, config: McpServerConfig): boolean {
	if (config.id !== BGB_SIDEBAR_MCP_ID || config.transport !== "stdio" || config.cwd !== undefined || Object.keys(config.env).length !== 0) return false;
	let canonical: McpServerConfig;
	try {
		canonical = sidebarMcpConfig(ctx);
	} catch {
		return false;
	}
	return canonical.transport === "stdio" && config.command === canonical.command &&
		config.args.length === canonical.args.length && config.args.every((arg, index) => arg === canonical.args[index]);
}

/** Preserve existing enable choices and user-owned ID collisions without rewriting either. */
export async function registerSidebarMcpConfig(ctx: CoreContext): Promise<void> {
	const canonical = sidebarMcpConfig(ctx);
	await mutateMcpConfig(ctx.paths, (servers) => {
		if (!servers.some((server) => server.id === canonical.id)) servers.push(canonical);
	});
}

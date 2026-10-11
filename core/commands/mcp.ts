import { serveSidebarMcp } from "../mcp-sidebar.ts";
import { UsageError } from "./args.ts";
import type { CommandEnv } from "./env.ts";

export async function runMcp(env: CommandEnv, argv: readonly string[]): Promise<number> {
	if (argv.length !== 1 || argv[0] !== "sidebar-folders") throw new UsageError("usage: bgb mcp sidebar-folders");
	const ctx = await env.context();
	await serveSidebarMcp(ctx.paths);
	return 0;
}

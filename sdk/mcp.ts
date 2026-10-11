/** MCP server configuration shared by plugins and the host. New servers should be saved disabled until the user enables them. */
export type McpServerConfig = {
	id: string;
	name: string;
	enabled: boolean;
} & (
	| {
			transport: "stdio";
			command: string;
			args: string[];
			env: Record<string, string>;
			cwd?: string;
		}
	| {
			transport: "http" | "sse";
			url: string;
			headers: Record<string, string>;
		}
);

export interface McpServerStatus {
	config: McpServerConfig;
	state: "disconnected" | "connecting" | "connected" | "error";
	detail?: string;
	toolCount: number;
}

export interface McpTool {
	serverId: string;
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
	content: unknown[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/** Host-authored invocation origin, never accepted from model tool arguments. */
export interface McpCallContext {
	rendererConnectionId: number;
}

/** Host-managed MCP servers; bridge failures reject instead of returning empty results. */
export interface McpService {
	list(): Promise<McpServerStatus[]>;
	save(server: McpServerConfig): Promise<void>;
	remove(id: string): Promise<void>;
	connect(id: string): Promise<McpServerStatus>;
	/** Discovers tools from enabled configurations only. */
	tools(): Promise<McpTool[]>;
	/** Calls a tool on an enabled configuration only. */
	call(serverId: string, name: string, args: Record<string, unknown>, context?: McpCallContext): Promise<McpToolResult>;
}

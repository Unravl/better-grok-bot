import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { BGB_RENDERER_META_KEY, type McpCallContext, type McpServerConfig, type McpServerStatus, type McpService, type McpTool, type McpToolResult } from "../../sdk/index.ts";
import type { CoreContext } from "../context.ts";
import { BgbError, errorMessage } from "../errors.ts";
import { mutateMcpConfig, parseMcpArguments, parseMcpServerConfig, readMcpConfig } from "../mcp-config.ts";
import { isManagedSidebarMcpConfig } from "../mcp-sidebar-config.ts";
import { BGB_VERSION } from "../version.ts";

export interface McpServersOptions {
	/** One deadline for initialization and every tools/list page, below the renderer's bridge deadline. */
	connectionTimeoutMs?: number;
	callTimeoutMs?: number;
	/** The SDK gives stdio children up to four seconds to exit before SIGKILL. */
	closeTimeoutMs?: number;
	/** Transport seam for deterministic stdio wire tests; production uses the official transport. */
	createStdioTransport?(config: Extract<McpServerConfig, { transport: "stdio" }>): Transport;
}

interface Session {
	config: McpServerConfig;
	client: Client;
	transport: Transport;
	lifetime: AbortController;
	state: McpServerStatus["state"];
	detail?: string;
	tools: Map<string, McpTool>;
	discovery: Promise<void> | null;
	initialized: boolean;
	closed: boolean;
	closing: Promise<void> | null;
}

function duration(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) throw new Error("MCP deadlines must be positive finite milliseconds");
	return value;
}

/** Also bounds transport.start(), which the SDK's JSON-RPC request timeout does not cover. */
async function deadline<T>(milliseconds: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	let timer: Timer | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new Error("MCP request timed out");
			controller.abort(error);
			reject(error);
		}, milliseconds);
	});
	try {
		return await Promise.race([run(controller.signal), expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** Transport errors sometimes echo a URL, header, command argument or environment value. */
function safeDetail(error: unknown, config: McpServerConfig): string {
	let message = errorMessage(error);
	const privateValues = config.transport === "stdio"
		? [...config.args, ...Object.values(config.env)]
		: [config.url, ...Object.values(config.headers)];
	for (const value of privateValues.filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) {
		message = message.split(value).join("[redacted]");
	}
	return message.slice(0, 1_000);
}

/** Agent-owned MCP clients. Merely reading settings never starts a process or contacts a server. */
export class McpServers implements McpService {
	private readonly ctx: CoreContext;
	private readonly connectionTimeoutMs: number;
	private readonly callTimeoutMs: number;
	private readonly closeTimeoutMs: number;
	private readonly createStdioTransport: McpServersOptions["createStdioTransport"];
	private readonly configs = new Map<string, McpServerConfig>();
	private readonly sessions = new Map<string, Session>();
	private loading: Promise<void> | null = null;
	private mutations: Promise<void> = Promise.resolve();
	private stopped = false;
	private stopping: Promise<void> | null = null;

	constructor(ctx: CoreContext, options: McpServersOptions = {}) {
		this.ctx = ctx;
		this.connectionTimeoutMs = duration(options.connectionTimeoutMs, 20_000);
		this.callTimeoutMs = duration(options.callTimeoutMs, 25_000);
		this.closeTimeoutMs = duration(options.closeTimeoutMs, 4_500);
		this.createStdioTransport = options.createStdioTransport;
	}

	private async load(): Promise<void> {
		if (this.stopped) throw new BgbError("unavailable", "MCP service is stopped");
		this.loading ??= readMcpConfig(this.ctx.paths).then((servers) => {
			for (const config of servers) this.configs.set(config.id, config);
		}).catch((error: unknown) => {
			this.loading = null;
			throw new BgbError("unavailable", `Cannot read MCP configuration: ${errorMessage(error)}`);
		});
		await this.loading;
		if (this.stopped) throw new BgbError("unavailable", "MCP service is stopped");
	}

	private config(id: string): McpServerConfig {
		const config = this.configs.get(id);
		if (!config) throw new BgbError("not-found", "MCP server is not configured");
		return config;
	}

	private status(config: McpServerConfig): McpServerStatus {
		const session = this.sessions.get(config.id);
		return {
			config: structuredClone(config),
			state: session?.state ?? "disconnected",
			...(session?.detail === undefined ? {} : { detail: session.detail }),
			toolCount: session?.tools.size ?? 0,
		};
	}

	async list(): Promise<McpServerStatus[]> {
		await this.load();
		return [...this.configs.values()].map((config) => this.status(config));
	}

	private mutate(run: () => Promise<void>): Promise<void> {
		const next = this.mutations.then(async () => {
			await this.load();
			await run();
		});
		this.mutations = next.catch(() => undefined);
		return next;
	}

	/** Invalidate before awaiting close, so no in-flight request can use a changed configuration. */
	private async replaceConfigs(configs: McpServerConfig[]): Promise<void> {
		const next = new Map(configs.map((config) => [config.id, config]));
		const stale: Session[] = [];
		for (const [id, session] of this.sessions) {
			const config = next.get(id);
			if (!config || JSON.stringify(config) !== JSON.stringify(session.config)) {
				this.sessions.delete(id);
				stale.push(session);
			}
		}
		this.configs.clear();
		for (const [id, config] of next) this.configs.set(id, config);
		await Promise.all(stale.map((session) => this.close(session)));
	}

	async save(server: McpServerConfig): Promise<void> {
		const config = parseMcpServerConfig(server);
		await this.mutate(async () => {
			const configs = await mutateMcpConfig(this.ctx.paths, (servers) => {
				const index = servers.findIndex((candidate) => candidate.id === config.id);
				if (index === -1) servers.push(config);
				else servers[index] = config;
			});
			await this.replaceConfigs(configs);
		});
	}

	async remove(id: string): Promise<void> {
		await this.mutate(async () => {
			const configs = await mutateMcpConfig(this.ctx.paths, (servers) => {
				const index = servers.findIndex((candidate) => candidate.id === id);
				if (index === -1) throw new BgbError("not-found", "MCP server is not configured");
				servers.splice(index, 1);
			});
			await this.replaceConfigs(configs);
		});
	}

	private createSession(config: McpServerConfig): Session {
		const lifetime = new AbortController();
		const network: FetchLike = (url, init) => fetch(url, {
			...init,
			signal: init?.signal ? AbortSignal.any([lifetime.signal, init.signal]) : lifetime.signal,
		});
		let transport: Transport;
		if (config.transport === "stdio") {
			transport = this.createStdioTransport?.(config) ?? new StdioClientTransport({
				command: config.command,
				args: config.args,
				env: { ...getDefaultEnvironment(), ...config.env },
				cwd: config.cwd,
				// MCP servers can print credentials on stderr. Never inherit or log their output.
				stderr: "ignore",
			});
		} else if (config.transport === "http") {
			transport = new StreamableHTTPClientTransport(new URL(config.url), {
				requestInit: { headers: config.headers },
				fetch: network,
			});
		} else {
			// SDK1.32 applies requestInit.headers to both the initial SSE GET and subsequent POSTs.
			transport = new SSEClientTransport(new URL(config.url), {
				requestInit: { headers: config.headers },
				fetch: network,
			});
		}
		// Initialization failures trigger an unawaited SDK close. Share that same close promise so
		// shutdown/edit cannot return while a stdio child is still in the SDK's exit grace period.
		const closeTransport = transport.close.bind(transport);
		let transportClosing: Promise<void> | null = null;
		transport.close = () => transportClosing ??= closeTransport();
		const client = new Client({ name: "better-grok-bot", version: BGB_VERSION }, { capabilities: {} });
		const session: Session = {
			config, client, transport, lifetime, state: "connecting", tools: new Map(),
			discovery: null, initialized: false, closed: false, closing: null,
		};
		client.onclose = () => {
			if (session.closed) return;
			session.closed = true;
			lifetime.abort();
			session.state = "disconnected";
			session.detail = "MCP connection closed";
			session.tools.clear();
		};
		client.onerror = (error) => {
			if (session.closed) return;
			session.state = "error";
			session.detail = safeDetail(error, config);
			session.tools.clear();
			void this.close(session);
		};
		return session;
	}

	private active(session: Session): void {
		if (this.stopped || session.closed || this.sessions.get(session.config.id) !== session) {
			throw new BgbError("unavailable", "MCP connection is no longer active");
		}
	}

	private async discover(session: Session): Promise<void> {
		if (session.discovery) return session.discovery;
		const operation = deadline(this.connectionTimeoutMs, async (signal) => {
			const options: RequestOptions = {
				signal: AbortSignal.any([signal, session.lifetime.signal]),
				timeout: this.connectionTimeoutMs,
				maxTotalTimeout: this.connectionTimeoutMs,
				resetTimeoutOnProgress: false,
			};
			if (!session.initialized) {
				await session.client.connect(session.transport, options);
				this.active(session);
				session.initialized = true;
			}
			const discovered = new Map<string, McpTool>();
			if (session.client.getServerCapabilities()?.tools) {
				let cursor: string | undefined;
				const cursors = new Set<string>();
				do {
					const page = await session.client.listTools(cursor === undefined ? {} : { cursor }, options);
					this.active(session);
					for (const tool of page.tools) {
						if (discovered.has(tool.name)) throw new Error("MCP server returned duplicate tool names");
						discovered.set(tool.name, {
							serverId: session.config.id,
							name: tool.name,
							...(tool.description === undefined ? {} : { description: tool.description }),
							inputSchema: tool.inputSchema,
						});
					}
					cursor = page.nextCursor;
					if (cursor !== undefined) {
						if (cursors.has(cursor)) throw new Error("MCP server repeated a tools pagination cursor");
						cursors.add(cursor);
					}
				} while (cursor !== undefined);
			}
			this.active(session);
			session.tools = discovered;
			session.state = "connected";
			session.detail = undefined;
		});
		session.discovery = operation.catch((error: unknown) => {
			session.state = "error";
			session.detail = safeDetail(error, session.config);
			session.tools.clear();
			void this.close(session);
		}).finally(() => {
			session.discovery = null;
		});
		await session.discovery;
	}

	async connect(id: string): Promise<McpServerStatus> {
		await this.load();
		this.config(id);
		let session = this.sessions.get(id);
		if (session?.closed) {
			await this.close(session);
			session = this.sessions.get(id);
		}
		if (!session || session.closed) {
			session = this.createSession(this.config(id));
			this.sessions.set(id, session);
		}
		await this.discover(session);
		return this.status(this.config(id));
	}

	async tools(): Promise<McpTool[]> {
		await this.load();
		const enabled = [...this.configs.values()].filter((config) => config.enabled);
		await Promise.all(enabled.map((config) => this.connect(config.id).catch(() => undefined)));
		// Read the current configs again: a save/remove may have invalidated a connection during discovery.
		const tools: McpTool[] = [];
		for (const config of this.configs.values()) {
			if (!config.enabled) continue;
			const session = this.sessions.get(config.id);
			if (session?.state === "connected" && !session.closed) {
				for (const tool of session.tools.values()) tools.push(structuredClone(tool));
			}
		}
		return tools;
	}

	async call(serverId: string, name: string, args: Record<string, unknown>, context?: McpCallContext): Promise<McpToolResult> {
		const argumentsValue = parseMcpArguments(args);
		await this.load();
		const config = this.config(serverId);
		if (!config.enabled) throw new BgbError("permission-denied", "MCP server is disabled");
		const session = this.sessions.get(serverId);
		if (!session || session.state !== "connected" || session.closed) {
			throw new BgbError("unavailable", "MCP server is not connected; refresh tools first");
		}
		if (!session.tools.has(name)) throw new BgbError("not-found", "MCP tool was not discovered on this server");
		// Invocation-scoped metadata only: one MCP session may serve several voice windows.
		const rendererConnectionId = context?.rendererConnectionId;
		const metadata = rendererConnectionId !== undefined && isManagedSidebarMcpConfig(this.ctx, config)
			? { [BGB_RENDERER_META_KEY]: rendererConnectionId }
			: undefined;
		if (metadata && (typeof rendererConnectionId !== "number" || !Number.isSafeInteger(rendererConnectionId) || rendererConnectionId <= 0)) {
			throw new BgbError("bad-request", "Renderer connection context must be a positive safe integer");
		}
		try {
			const result = await deadline(this.callTimeoutMs, (signal) => session.client.callTool(
				{ name, arguments: argumentsValue, ...(metadata === undefined ? {} : { _meta: metadata }) },
				CallToolResultSchema,
				{
					signal: AbortSignal.any([signal, session.lifetime.signal]),
					timeout: this.callTimeoutMs,
					maxTotalTimeout: this.callTimeoutMs,
					resetTimeoutOnProgress: false,
				},
			));
			this.active(session);
			if (!Array.isArray(result.content)) throw new Error("MCP server returned an invalid tool result");
			return result as McpToolResult;
		} catch (error) {
			if (error instanceof BgbError) throw error;
			const detail = safeDetail(error, config);
			if (!(error instanceof McpError) || error.code === ErrorCode.ConnectionClosed || error.code === ErrorCode.RequestTimeout) {
				session.state = "error";
				session.detail = detail;
				session.tools.clear();
				void this.close(session);
			}
			throw new BgbError("unavailable", detail, error instanceof McpError
				? { mcpCode: error.code, ...(error.data === undefined ? {} : { mcpData: error.data }) }
				: undefined);
		}
	}

	private close(session: Session): Promise<void> {
		if (session.closing) return session.closing;
		session.closed = true;
		session.lifetime.abort();
		session.tools.clear();
		session.closing = deadline(this.closeTimeoutMs, async () => {
			await session.client.close();
		}).catch(() => undefined);
		return session.closing;
	}

	shutdown(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.stopped = true;
		this.stopping = this.mutations.then(async () => {
			await this.loading?.catch(() => undefined);
			await Promise.all([...this.sessions.values()].map((session) => this.close(session)));
			this.sessions.clear();
		});
		return this.stopping;
	}
}

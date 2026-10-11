import type { ComponentFactory, McpServerConfig, McpServerStatus } from "@better-grok-bot/sdk";

interface ServerDraft {
	id: string;
	name: string;
	enabled: boolean;
	transport: "stdio" | "http" | "sse";
	command: string;
	args: string;
	env: string;
	cwd: string;
	url: string;
	headers: string;
}

function emptyDraft(): ServerDraft {
	return { id: "", name: "", enabled: false, transport: "stdio", command: "", args: "[]", env: "{}", cwd: "", url: "", headers: "{}" };
}

function stringMap(source: string, label: string): Record<string, string> {
	const value: unknown = JSON.parse(source);
	if (value === null || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
		throw new Error(`${label} must be a JSON object with string values.`);
	}
	return value as Record<string, string>;
}

function configuration(draft: ServerDraft): McpServerConfig {
	const name = draft.name.trim();
	if (!name) throw new Error("Enter a server name.");
	const base = { id: draft.id || crypto.randomUUID(), name, enabled: draft.enabled };
	if (draft.transport === "stdio") {
		const command = draft.command.trim();
		if (!command) throw new Error("Enter a local command.");
		const args: unknown = JSON.parse(draft.args);
		if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) throw new Error("Arguments must be a JSON array of strings.");
		return { ...base, transport: "stdio", command, args: args as string[], env: stringMap(draft.env, "Environment"), ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}) };
	}
	const url = draft.url.trim();
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Server URL must use HTTP or HTTPS.");
	return { ...base, transport: draft.transport, url, headers: stringMap(draft.headers, "Headers") };
}

function editDraft(config: McpServerConfig): ServerDraft {
	const draft = { ...emptyDraft(), id: config.id, name: config.name, enabled: config.enabled, transport: config.transport };
	return config.transport === "stdio"
		? { ...draft, command: config.command, args: JSON.stringify(config.args, null, 2), env: JSON.stringify(config.env, null, 2), cwd: config.cwd ?? "" }
		: { ...draft, url: config.url, headers: JSON.stringify(config.headers, null, 2) };
}

export const createSettings: ComponentFactory = ({ React, jsx, Row }, ctx) => {
	return function VoiceMcpSettings() {
		const [servers, setServers] = React.useState<McpServerStatus[]>([]);
		const [draft, setDraft] = React.useState<ServerDraft>(emptyDraft);
		const [busy, setBusy] = React.useState(false);
		const [error, setError] = React.useState("");
		const [notice, setNotice] = React.useState("");
		const active = React.useRef(false);
		const mounted = React.useRef(true);
		const service = ctx.services.mcp;

		const run = async (operation: () => Promise<void>): Promise<void> => {
			if (active.current) return;
			active.current = true;
			setBusy(true);
			setError("");
			setNotice("");
			try {
				await operation();
			} catch (cause) {
				if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				active.current = false;
				if (mounted.current) setBusy(false);
			}
		};
		const refresh = async (): Promise<void> => {
			const next = await service.list();
			if (mounted.current) setServers(next);
		};
		React.useEffect(() => {
			mounted.current = true;
			void run(refresh);
			return () => { mounted.current = false; };
		}, [service]);

		const textField = (label: string, key: "name" | "command" | "args" | "env" | "cwd" | "url" | "headers", multiline = false): unknown => jsx("label", {
			className: "bgb-voice-mcp-field",
			children: [jsx("span", { children: label }), jsx(multiline ? "textarea" : "input", {
				value: draft[key],
				...(multiline ? { rows: 3, spellCheck: false } : { type: "text" }),
				onChange: (event: { currentTarget: { value: string } }) => {
					const value = event.currentTarget.value;
					setDraft((previous) => ({ ...previous, [key]: value }));
				},
			})],
		});
		const button = (label: string, onClick: () => void): unknown => jsx("button", { type: "button", disabled: busy, onClick, children: label });
		const content = jsx("section", {
			className: "bgb-voice-mcp",
			"aria-label": "Voice MCP servers",
			"aria-busy": busy,
			children: [
				jsx("h3", { children: "Voice MCP servers" }),
				jsx("p", { children: "MCP tools are available in voice only. Trusted stdio commands execute locally on your computer. Enabled tools require no per-call permission; the remote voice model receives their tool schemas and results. OAuth is not supported. Rejoin voice after changing servers or enabling tools." }),
				jsx("p", { children: "New servers are disabled by default. Connection tests also work while disabled and never enable a server. Test saved settings; save edits before testing." }),
				button("Refresh status", () => { void run(refresh); }),
				jsx("p", { role: "status", "aria-live": "polite", children: busy ? "Working…" : notice }),
				error ? jsx("p", { role: "alert", className: "bgb-voice-mcp-error", children: error }) : null,
				jsx("ul", {
					className: "bgb-voice-mcp-servers",
					children: servers.map((server) => jsx("li", {
						children: [
							jsx("strong", { children: server.config.name }),
							jsx("p", { children: `${server.config.transport} · ${server.state} · ${server.toolCount} tools${server.detail ? ` · ${server.detail}` : ""}` }),
							jsx("label", { children: [jsx("input", {
								type: "checkbox", checked: server.config.enabled, disabled: busy,
								onChange: (event: { currentTarget: { checked: boolean } }) => {
									const enabled = event.currentTarget.checked;
									void run(async () => {
										await service.save({ ...server.config, enabled });
										if (mounted.current) {
											setDraft((previous) => previous.id === server.config.id ? { ...previous, enabled } : previous);
											setNotice("Enable setting saved. Rejoin voice to apply changes.");
										}
										await refresh();
									});
								},
							}), `Enable ${server.config.name} for voice`] }),
							jsx("div", { className: "bgb-voice-mcp-actions", children: [
								button(`Edit ${server.config.name}`, () => { setDraft(editDraft(server.config)); setError(""); setNotice(""); }),
								button(`Test connection to ${server.config.name}`, () => { void run(async () => {
									const status = await service.connect(server.config.id);
									if (mounted.current) {
										setServers((previous) => previous.map((entry) => entry.config.id === status.config.id ? status : entry));
										if (status.state === "error") setError(status.detail ?? "Connection test failed.");
										else setNotice(`${status.config.name}: ${status.state}, ${status.toolCount} tools. Enable setting unchanged.`);
									}
								}); }),
								button(`Remove ${server.config.name}`, () => { void run(async () => {
									await service.remove(server.config.id);
									if (mounted.current) {
										setDraft((previous) => previous.id === server.config.id ? emptyDraft() : previous);
										setNotice("Server removed. Rejoin voice to apply changes.");
									}
									await refresh();
								}); }),
							] }),
						],
					}, server.config.id)),
				}),
				!busy && servers.length === 0 ? jsx("p", { children: "No saved MCP servers." }) : null,
				jsx("form", {
					onSubmit: (event: { preventDefault(): void }) => {
						event.preventDefault();
						void run(async () => {
							await service.save(configuration(draft));
							if (mounted.current) {
								setDraft(emptyDraft());
								setNotice("Server saved. New servers remain disabled until explicitly enabled. Rejoin voice to apply changes.");
							}
							await refresh();
						});
					},
					children: jsx("fieldset", { disabled: busy, children: [
						jsx("legend", { children: draft.id ? "Edit MCP server" : "Add MCP server (disabled by default)" }),
						textField("Server name", "name"),
						jsx("label", { className: "bgb-voice-mcp-field", children: [jsx("span", { children: "Transport" }), jsx("select", {
							value: draft.transport,
							onChange: (event: { currentTarget: { value: string } }) => {
								const transport = event.currentTarget.value;
								if (transport === "stdio" || transport === "http" || transport === "sse") setDraft((previous) => ({ ...previous, transport }));
							},
							children: [jsx("option", { value: "stdio", children: "stdio (local command)" }), jsx("option", { value: "http", children: "HTTP" }), jsx("option", { value: "sse", children: "SSE" })],
						})] }),
						...(draft.transport === "stdio" ? [textField("Command", "command"), textField("Arguments (JSON array of strings)", "args", true), textField("Environment (JSON object of string values)", "env", true), textField("Working directory (optional)", "cwd")] : [textField("Server URL", "url"), textField("Headers (JSON object of string values)", "headers", true)]),
						jsx("div", { className: "bgb-voice-mcp-actions", children: [jsx("button", { type: "submit", children: "Save server" }), button(draft.id ? "Cancel editing" : "Clear form", () => { setDraft(emptyDraft()); setError(""); })] }),
					] }),
				}),
			],
		});
		return Row === undefined ? content : jsx(Row, { label: "Voice MCP servers", variant: "card", children: content });
	};
};

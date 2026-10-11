import type {
	BuildManifest,
	KeysState,
	MediaState,
	PluginSource,
	PluginState,
	ServiceStateInfo,
	ThemeInfo,
	UpdateStatus,
} from "../../sdk/index.ts";
import { type AgentHealth, readLiveAgent } from "../agent-record.ts";
import { type Config, readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { rendererUrl } from "../paths.ts";
import type { AppInstall } from "../platform/types.ts";
import { type State, readState } from "../state.ts";
import { BGB_COMPILED, BGB_VERSION } from "../version.ts";
import { type ParsedArgs, parseArgs } from "./args.ts";
import { type CommandEnv, fetchHealth } from "./env.ts";

/** `bgb status --json`; `scripts/e2e.ts` asserts on these fields. */
export interface StatusReport {
	bgbVersion: string;
	agent: { running: boolean; pid: number | null; port: number | null };
	hook: "active" | "absent" | "conflict";
	app: { path: string; version: string; running: boolean } | null;
	renderers: { buildKey: string; connectedAt: string }[];
	build: { key: string; appVersion: string; builtAt: string } | null;
	plugins: { id: string; source: PluginSource; state: PluginState; errors: string[] }[];
	themes: ThemeInfo[];
	keys: ServiceStateInfo<KeysState> | null;
	media: ServiceStateInfo<MediaState> | null;
	update: UpdateStatus;
}

/** Functions from other modules `collectStatus` uses; a test seam. */
export interface StatusDeps {
	resolveApp(ctx: CoreContext, explicit: string | null): Promise<AppInstall>;
	readBuildManifest(ctx: CoreContext, key: string, appVersion: string): Promise<BuildManifest | null>;
	listThemes(ctx: CoreContext, config: Config): Promise<ThemeInfo[]>;
	health(port: number): Promise<AgentHealth | null>;
}

export interface StatusDetails {
	report: StatusReport;
	/** The foreign `VITE_DEV_SERVER_URL` when `hook` is `conflict`. */
	hookValue?: string;
	/** Why `app` is null. */
	appError?: string;
}

// Loaded per command (literal specifiers, so the compiled binary bundles them) to keep startup light.
async function loadStatusDeps(): Promise<StatusDeps> {
	const [resolve, build, themes] = await Promise.all([
		import("../app/resolve.ts"),
		import("../build/index.ts"),
		import("../themes/index.ts"),
	]);
	return {
		resolveApp: resolve.resolveApp,
		readBuildManifest: build.readBuildManifest,
		listThemes: themes.listThemes,
		health: (port) => fetchHealth(port),
	};
}

/** -1, 0 or 1 comparing `x.y.z[-pre]` versions; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string): [number[], string] => {
		const [core = "", pre = ""] = v.replace(/^v/, "").split("-", 2);
		return [core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre];
	};
	const [aCore, aPre] = parse(a);
	const [bCore, bPre] = parse(b);
	for (let i = 0; i < 3; i++) {
		const diff = (aCore[i] ?? 0) - (bCore[i] ?? 0);
		if (diff !== 0) return Math.sign(diff);
	}
	if (aPre === bPre) return 0;
	if (aPre === "") return 1;
	if (bPre === "") return -1;
	return aPre < bPre ? -1 : 1;
}

/** The self-update status recorded in `state.json`, as the CLI sees it without asking the agent. */
export function updateStatusFromState(update: State["update"]): UpdateStatus {
	if (!BGB_COMPILED) return { state: "disabled", current: BGB_VERSION };
	if (update.error) return { state: "error", current: BGB_VERSION, error: update.error, ...(update.latest ? { latest: update.latest } : {}) };
	if (update.pending && update.pending.version !== BGB_VERSION) {
		return { state: "installed", current: BGB_VERSION, latest: update.pending.version };
	}
	if (update.latest && compareVersions(update.latest, BGB_VERSION) > 0) {
		return { state: "available", current: BGB_VERSION, latest: update.latest };
	}
	return { state: "idle", current: BGB_VERSION };
}

/** Reads `state.json`, `/health` and the platform; never connects to the bridge. */
export async function collectStatus(ctx: CoreContext, deps: StatusDeps): Promise<StatusDetails> {
	const config = await readConfig(ctx.paths);
	const state = await readState(ctx.paths);
	const record = await readLiveAgent(ctx.paths);
	const health = record ? await deps.health(record.port) : null;

	let app: AppInstall | undefined;
	let appError: string | undefined;
	try {
		app = await deps.resolveApp(ctx, config.appPath);
	} catch (error) {
		appError = errorMessage(error);
	}
	const hook = await ctx.platform.hookStatus(rendererUrl(ctx.paths), app);
	const manifest = state.lastBuild ? await deps.readBuildManifest(ctx, state.lastBuild.key, state.lastBuild.appVersion) : null;

	const report: StatusReport = {
		bgbVersion: BGB_VERSION,
		agent: {
			running: health !== null,
			pid: health?.pid ?? record?.pid ?? null,
			port: record?.port ?? null,
		},
		hook: hook.state,
		app: app
			? { path: app.root, version: app.version, running: (await ctx.platform.findRunningApp(app)) !== undefined }
			: null,
		renderers: record ? state.renderers : [],
		build: state.lastBuild,
		plugins: (manifest?.plugins ?? []).map(({ id, source, state: pluginState, errors }) => ({
			id,
			source,
			state: pluginState,
			errors,
		})),
		themes: await deps.listThemes(ctx, config),
		keys: record ? (state.services?.keys ?? null) : null,
		media: record ? (state.services?.media ?? null) : null,
		update: updateStatusFromState(state.update),
	};
	return { report, ...(hook.state === "conflict" ? { hookValue: hook.value } : {}), ...(appError ? { appError } : {}) };
}

export function describeUpdate(update: UpdateStatus): string {
	switch (update.state) {
		case "disabled":
			return "self-update works only in the installed binary";
		case "available":
			return `${update.latest} is available (run: bgb update)`;
		case "installed":
			return `${update.latest} is installed; the agent restarts on it`;
		case "error":
			return `failed: ${update.error ?? "unknown error"}`;
		case "idle":
			return `${update.current} is up to date`;
		default:
			return update.state;
	}
}

function printStatus(env: CommandEnv, ctx: CoreContext, details: StatusDetails): void {
	const { io } = env;
	const { report } = details;
	io.out(`Better Grok Bot ${report.bgbVersion} (data: ${ctx.paths.root})`);
	io.out(
		report.agent.running
			? `Agent: running (pid ${report.agent.pid}, port ${report.agent.port})`
			: "Agent: not running (run: bgb start)",
	);
	io.out(
		report.hook === "conflict"
			? `Hook: conflict — VITE_DEV_SERVER_URL is set to ${details.hookValue} by something else`
			: `Hook: ${report.hook}`,
	);
	io.out(
		report.app
			? `Grok Bot: ${report.app.version} at ${report.app.path} (${report.app.running ? "running" : "not running"})`
			: `Grok Bot: not found (${details.appError ?? "unknown error"})`,
	);
	io.out(
		report.renderers.length === 0
			? "Windows: none connected"
			: `Windows: ${report.renderers.map((r) => r.buildKey.slice(0, 12)).join(", ")}`,
	);
	if (report.keys) io.out(`Background keys: ${report.keys.state}${report.keys.detail ? ` (${report.keys.detail})` : ""}`);
	if (report.media) io.out(`Media ducking: ${report.media.state}${report.media.detail ? ` (${report.media.detail})` : ""}`);
	io.out(
		report.build
			? `Last build: ${report.build.key.slice(0, 12)} for Grok Bot ${report.build.appVersion} at ${report.build.builtAt}`
			: "Last build: none (run: bgb build)",
	);
	if (report.plugins.length > 0) io.out("Plugins:");
	for (const plugin of report.plugins) {
		if (plugin.source === "core") continue;
		const mark = plugin.state === "active" ? "✓" : plugin.state === "disabled" ? "-" : "✗";
		io.out(`  ${mark} ${plugin.id} (${plugin.source}) — ${plugin.state}${plugin.errors[0] ? `: ${plugin.errors[0]}` : ""}`);
	}
	if (report.themes.length > 0) io.out("Themes:");
	for (const theme of report.themes) {
		const mark = !theme.valid ? "✗" : theme.enabled ? "✓" : "-";
		io.out(`  ${mark} ${theme.id} — ${theme.valid ? theme.name : (theme.error ?? "invalid")}`);
	}
	io.out(`Update: ${describeUpdate(report.update)}`);
}

export async function runStatus(env: CommandEnv, argv: readonly string[], deps?: StatusDeps): Promise<number> {
	const args: ParsedArgs = parseArgs(argv, { flags: { "--json": "boolean" }, usage: "bgb status [--json]" });
	const ctx = await env.context();
	const details = await collectStatus(ctx, deps ?? (await loadStatusDeps()));
	if (args.has("--json")) env.io.out(JSON.stringify(details.report, null, 2));
	else printStatus(env, ctx, details);
	return 0;
}

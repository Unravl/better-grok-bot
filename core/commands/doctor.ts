// App and build modules load per command (literal specifiers, so the compiled binary bundles them).
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import * as asar from "@electron/asar";
import { type PluginStatus, RENDERER_URL_ENV } from "../../sdk/index.ts";
import { type AgentHealth, readLiveAgent } from "../agent-record.ts";
import { type Config, readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { rendererUrl } from "../paths.ts";
import type { AppInstall } from "../platform/types.ts";
import { readState } from "../state.ts";
import { BGB_COMPILED } from "../version.ts";
import { parseArgs } from "./args.ts";
import { type CommandEnv, fetchHealth } from "./env.ts";

type Mark = "ok" | "fail" | "warn" | "info";
const SYMBOL: Readonly<Record<Mark, string>> = { ok: "✓", fail: "✗", warn: "!", info: "·" };

/** `app.asar` files of other Electron apps that would also see a global `VITE_DEV_SERVER_URL`. */
async function otherAppAsars(ctx: CoreContext): Promise<string[]> {
	let pattern: { root: string; rel: string[] } | undefined;
	if (ctx.platform.id === "darwin") pattern = { root: "/Applications", rel: ["Contents", "Resources", "app.asar"] };
	else if (ctx.platform.id === "win32" && process.env.LOCALAPPDATA) {
		pattern = { root: path.join(process.env.LOCALAPPDATA, "Programs"), rel: ["resources", "app.asar"] };
	}
	if (!pattern) return [];
	let names: string[];
	try {
		names = await readdir(pattern.root);
	} catch {
		return [];
	}
	const { root, rel } = pattern;
	return names
		.filter((name) => ctx.platform.id !== "darwin" || name.endsWith(".app"))
		.map((name) => path.join(root, name, ...rel))
		.filter((file) => existsSync(file));
}

/** Reads the asar's `package.json` `main` file in memory and looks for the variable. */
async function readsRendererVariable(asarPath: string): Promise<boolean> {
	const { withArchive } = await import("../app/asar.ts");
	return withArchive(asarPath, () => {
		const pkg = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8")) as { main?: unknown };
		const main = (typeof pkg.main === "string" ? pkg.main : "index.js").replace(/^\.\//, "");
		return asar.extractFile(asarPath, main).toString("utf8").includes(RENDERER_URL_ENV);
	});
}

/** Checks the install end to end and prints ✓/✗ lines with hints; exit 1 when any check fails. */
export async function runDoctor(env: CommandEnv, argv: readonly string[]): Promise<number> {
	parseArgs(argv, { usage: "bgb doctor" });
	const ctx = await env.context();
	const { paths, platform } = ctx;
	let failures = 0;
	const report = (mark: Mark, text: string, hint?: string): void => {
		if (mark === "fail") failures++;
		env.io.out(`${SYMBOL[mark]} ${text}`);
		if (hint) env.io.out(`    → ${hint}`);
	};

	const installed = path.join(paths.bin, platform.binName());
	if (!existsSync(installed)) report("fail", `no bgb binary in ${paths.bin}`, "run: bgb setup");
	else if (BGB_COMPILED && path.resolve(process.execPath) !== installed) {
		report("warn", `this is ${process.execPath}; the installed binary is ${installed}`);
	} else report("ok", `binary ${installed}`);

	if (platform.id !== "win32") {
		const mode = (await stat(paths.root)).mode & 0o777;
		if (mode === 0o700) report("ok", `${paths.root} is private (0700)`);
		else report("fail", `${paths.root} has mode 0${mode.toString(8)}`, `run: chmod 700 "${paths.root}"`);
	}

	let config: Config | undefined;
	try {
		config = await readConfig(paths);
		report("ok", "config.json is valid");
	} catch (error) {
		report("fail", errorMessage(error), `fix or delete ${paths.config}, then run: bgb setup`);
	}
	const state = await readState(paths);

	let app: AppInstall | undefined;
	try {
		const [{ resolveApp }, { checkSupport }] = await Promise.all([import("../app/resolve.ts"), import("../app/asar.ts")]);
		app = await resolveApp(ctx, config?.appPath ?? null);
		await checkSupport(ctx, app.asarPath);
		report("ok", `Grok Bot ${app.version} at ${app.root} supports Better Grok Bot`);
	} catch (error) {
		report("fail", errorMessage(error), app ? undefined : "install Grok Bot, or run: bgb config set appPath <path>");
	}

	const hook = await platform.hookStatus(rendererUrl(paths), app);
	if (hook.state === "active") report("ok", "Grok Bot launches load Better Grok Bot (hook active)");
	else if (hook.state === "conflict") {
		report("fail", `${RENDERER_URL_ENV} is set to ${hook.value} by something else`, "remove it, then run: bgb setup");
	} else if (state.hook && platform.id === "darwin") {
		report("fail", `${RENDERER_URL_ENV} is not exported (launchd forgets it at reboot until the agent starts)`, "run: bgb start, then bgb restart");
	} else report("fail", "the Grok Bot hook is not installed", "run: bgb setup");

	const record = await readLiveAgent(paths);
	const health: AgentHealth | null = record ? await fetchHealth(record.port) : null;
	if (record && health) report("ok", `agent ${health.version} is running (pid ${health.pid}, port ${record.port})`);
	else if (record) report("fail", `agent pid ${record.pid} does not answer on port ${record.port}`, `see ${path.join(paths.logs, "agent.log")}`);
	else report("fail", "the agent is not running", "run: bgb start");

	const pending = state.update.pending;
	if (pending && health?.version !== pending.version) {
		report(
			"fail",
			`the update to ${pending.version} has not started (${health ? `agent ${health.version} is running` : "no agent"})`,
			`to go back to ${pending.previous}, run: "${path.join(paths.binPrevious, platform.binName())}" setup --yes`,
		);
	}

	if (app) {
		const running = await platform.findRunningApp(app);
		if (!running) report("info", "Grok Bot is not running");
		else if (record && state.renderers.length > 0) {
			report("ok", `Grok Bot is running with Better Grok Bot (${state.renderers.length} window(s) connected)`);
		} else report("fail", `Grok Bot is running without Better Grok Bot (pid ${running.pid})`, "run: bgb restart");
	}

	if (!state.lastBuild) report("fail", "nothing has been built yet", "run: bgb build");
	else {
		const { readBuildManifest } = await import("../build/index.ts");
		const manifest = await readBuildManifest(ctx, state.lastBuild.key, state.lastBuild.appVersion);
		const failed = (manifest?.plugins ?? []).filter(
			(plugin: PluginStatus) => plugin.state === "patch-failed" || plugin.state === "invalid",
		);
		if (!manifest) report("fail", `the last build ${state.lastBuild.key.slice(0, 12)} is missing`, "run: bgb build");
		else if (failed.length === 0) report("ok", `last build ${manifest.buildKey.slice(0, 12)} for Grok Bot ${manifest.appVersion}: no plugin failures`);
		for (const plugin of failed) {
			report("fail", `plugin ${plugin.id} (${plugin.source}) ${plugin.state}: ${plugin.errors[0] ?? "no details"}`, "update or disable it: bgb plugins update / bgb plugins disable");
		}
	}

	for (const asarPath of await otherAppAsars(ctx)) {
		if (app && path.resolve(asarPath) === path.resolve(app.asarPath)) continue;
		try {
			if (await readsRendererVariable(asarPath)) {
				report("warn", `${asarPath} also reads ${RENDERER_URL_ENV}; that app would try to load Grok Bot's patched renderer`);
			}
		} catch {
			// Not an Electron app with a readable package.json; it can't read the variable.
		}
	}

	env.io.out(failures === 0 ? "Everything looks good." : `${failures} problem(s) found.`);
	return failures === 0 ? 0 : 1;
}

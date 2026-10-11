import { RENDERER_URL_ENV } from "../../sdk/index.ts";
import type { CoreContext } from "../context.ts";
import { rendererUrl } from "../paths.ts";
import type { AppInstall } from "../platform/types.ts";
import { type SetupHost, systemHost } from "./host.ts";

export type RestartResult = "restarted" | "launched" | "skipped" | "did-not-quit";

export interface RestartOptions {
	/** Restart without asking. */
	yes: boolean;
	/** Force-quit when a graceful quit does not end Grok Bot. */
	force: boolean;
	/** Prompts may be answered (stdin is a terminal). */
	interactive: boolean;
	/** Extra arguments for the relaunched app. */
	args: string[];
}

const RESTART_HINT = "Restart Grok Bot to load Better Grok Bot.";

/**
 * Restarts Grok Bot on this install's renderer: asks first unless `yes` (non-interactive without `yes`
 * skips), quits it gracefully (force only with `force` or an interactive confirmation), then launches it
 * with `VITE_DEV_SERVER_URL` = {@link rendererUrl} and `args`. A Grok Bot that is not running is just
 * launched. Shared by `bgb setup` (step 13) and `bgb restart`.
 */
export async function restartApp(
	ctx: CoreContext,
	app: AppInstall,
	opts: RestartOptions,
	host: SetupHost = systemHost(),
): Promise<RestartResult> {
	if (app.executable === "") {
		// A bare `.asar` (`--app …/app.asar`) names no program to quit or launch.
		host.print(RESTART_HINT);
		return "skipped";
	}
	const env = { [RENDERER_URL_ENV]: rendererUrl(ctx.paths) };
	const running = await ctx.platform.findRunningApp(app);
	if (running === undefined) {
		await ctx.platform.launchApp(app, env, opts.args);
		return "launched";
	}
	const go = opts.yes || (opts.interactive && (await host.confirm("Restart Grok Bot now to load Better Grok Bot?", true)));
	if (!go) {
		host.print(RESTART_HINT);
		return "skipped";
	}
	let quit = await ctx.platform.quitApp(running.pid, { force: false });
	if (!quit) {
		const force = opts.force || (opts.interactive && (await host.confirm("Grok Bot did not quit. Force quit?", false)));
		if (force) quit = await ctx.platform.quitApp(running.pid, { force: true });
	}
	if (!quit) {
		host.print("Grok Bot did not quit; restart it yourself.");
		return "did-not-quit";
	}
	ctx.log.info(`restarting Grok Bot ${app.version} with ${RENDERER_URL_ENV}=${env[RENDERER_URL_ENV]}`);
	await ctx.platform.launchApp(app, env, opts.args);
	return "restarted";
}

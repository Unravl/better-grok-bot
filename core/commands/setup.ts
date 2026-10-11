// Setup modules load per command (literal specifiers, so the compiled binary bundles them).
import * as path from "node:path";
import { readConfig } from "../config.ts";
import { parseArgs } from "./args.ts";
import type { CommandEnv } from "./env.ts";

export async function runSetupCommand(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, {
		flags: {
			"--yes": "boolean",
			"--no-restart": "boolean",
			"--force": "boolean",
			"--app": "value",
			"--no-autostart": "boolean",
			"--no-hook": "boolean",
		},
		usage: "bgb setup [--yes] [--no-restart] [--force] [--app <path>] [--no-autostart] [--no-hook]",
	});
	const app = args.value("--app");
	const ctx = await env.context();
	const { runSetup } = await import("../setup/setup.ts");
	return runSetup(ctx, {
		yes: args.has("--yes"),
		noRestart: args.has("--no-restart"),
		force: args.has("--force"),
		app: app === undefined ? null : path.resolve(app),
		noAutostart: args.has("--no-autostart"),
		noHook: args.has("--no-hook"),
	});
}

export async function runUninstallCommand(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, {
		flags: { "--purge": "boolean", "--yes": "boolean" },
		usage: "bgb uninstall [--purge] [--yes]",
	});
	const ctx = await env.context();
	const { runUninstall } = await import("../setup/uninstall.ts");
	return runUninstall(ctx, { purge: args.has("--purge"), yes: args.has("--yes") });
}

/** `bgb restart [--yes] [--force] [-- <app args>]`: quit Grok Bot, then open it with the hook URL. */
export async function runRestart(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, {
		flags: { "--yes": "boolean", "--force": "boolean" },
		passthrough: true,
		usage: "bgb restart [--yes] [--force] [-- <app args>]",
	});
	const ctx = await env.context();
	const [{ resolveApp }, { restartApp }, { isInteractive }] = await Promise.all([
		import("../app/resolve.ts"),
		import("../setup/restart.ts"),
		import("../setup/prompt.ts"),
	]);
	const app = await resolveApp(ctx, (await readConfig(ctx.paths)).appPath);
	const result = await restartApp(ctx, app, {
		yes: args.has("--yes"),
		force: args.has("--force"),
		interactive: isInteractive(),
		args: [...args.passthrough],
	});
	switch (result) {
		case "restarted":
			env.io.out(`Restarted Grok Bot ${app.version} with Better Grok Bot.`);
			return 0;
		case "launched":
			env.io.out(`Opened Grok Bot ${app.version} with Better Grok Bot.`);
			return 0;
		case "skipped":
			env.io.out("Grok Bot was left running; restart it to load Better Grok Bot.");
			return 0;
		case "did-not-quit":
			env.io.err("bgb: Grok Bot did not quit; restart it yourself (or run: bgb restart --force).");
			return 1;
	}
}

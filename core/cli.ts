#!/usr/bin/env bun
import * as path from "node:path";
import { UsageError } from "./commands/args.ts";
import { type CliIo, type CommandEnv, consoleIo } from "./commands/env.ts";
import { type CoreContext, createContext } from "./context.ts";
import { errorMessage } from "./errors.ts";
import type { Logger } from "./log.ts";
import type { PlatformAdapter } from "./platform/types.ts";
import { BGB_VERSION } from "./version.ts";

const USAGE = `Better Grok Bot ${BGB_VERSION} — plugins and themes for the Grok Bot desktop app

Usage: bgb [--data-dir <path>] <command> [options]

Install and run
  setup [--yes] [--no-restart] [--force] [--app <path>] [--no-autostart] [--no-hook]
                                  Install BGB for this user and hook Grok Bot launches
  uninstall [--purge] [--yes]     Remove the hook, autostart and agent (--purge: all data)
  start | stop                    Start or stop the background agent
  restart [--yes] [--force] [-- <app args>]
                                  Quit Grok Bot and open it with Better Grok Bot
  status [--json]                 Agent, hook, app, build, plugins, themes, update
  doctor                          Check the install and explain problems
  update [--check]                Update Better Grok Bot now
  logs [-f]                       Print (or follow) the agent log
  mcp sidebar-folders             Serve sidebar folder tools over MCP stdio (voice preset)

Plugins and themes
  plugins [list]                  List plugins and their states
  plugins enable|disable <id>
  plugins install <path|url|github:owner/repo[@tag]> [--yes]
  plugins uninstall <id>
  plugins update [<id>] [--yes]
  themes [list]
  themes enable|disable <id>
  themes install <path|url>
  themes uninstall <id>

Build and develop
  build [--force] [--app <path>] [--json]
                                  Build the patched renderer now
  check --asar <path> [--json]    Test core and bundled plugins against an app.asar (exit 3 on failure)
  plugin new <id> [--dir <path>]  Scaffold a plugin
  plugin build [<dir>] [--out <file>]
                                  Package a plugin as <id>-<version>.bgbplugin
  dev <dir> [--yes]               Load a plugin from source and rebuild on every change
  renderer extract <dir> [--patched]
                                  Write Grok Bot's renderer files for finding patch anchors

Settings
  config get <key>
  config set <key> <value>        Keys: bridgePort, autoUpdate, openAtLogin, appPath

  --version                       Print the version
  help                            Show this help

Exit codes: 0 ok, 1 error, 2 usage error, 3 check found failures.`;

export interface MainOptions {
	io?: CliIo;
	/** Test seams passed to `createContext`. */
	platform?: PlatformAdapter;
	log?: Logger;
}

type Command = (env: CommandEnv, argv: readonly string[]) => Promise<number>;

/**
 * Command modules are imported per command (literal specifiers, so `bun build --compile` bundles every
 * one): `bgb --version` and `bgb check` load none of the agent, setup or platform code.
 */
const COMMANDS: Readonly<Record<string, () => Promise<Command>>> = {
	setup: async () => (await import("./commands/setup.ts")).runSetupCommand,
	uninstall: async () => (await import("./commands/setup.ts")).runUninstallCommand,
	restart: async () => (await import("./commands/setup.ts")).runRestart,
	start: async () => (await import("./commands/agent.ts")).runStart,
	stop: async () => (await import("./commands/agent.ts")).runStop,
	agent: async () => (await import("./commands/agent.ts")).runAgentCommand,
	update: async () => (await import("./commands/agent.ts")).runUpdate,
	"update-watchdog": async () => (await import("./commands/agent.ts")).runWatchdog,
	login: async () => (await import("./commands/login.ts")).runLogin,
	status: async () => (await import("./commands/status.ts")).runStatus,
	doctor: async () => (await import("./commands/doctor.ts")).runDoctor,
	build: async () => (await import("./commands/build.ts")).runBuild,
	check: async () => (await import("./commands/build.ts")).runCheck,
	renderer: async () => (await import("./commands/build.ts")).runRenderer,
	plugins: async () => (await import("./commands/plugins.ts")).runPlugins,
	themes: async () => (await import("./commands/themes.ts")).runThemes,
	plugin: async () => (await import("./commands/author.ts")).runPlugin,
	dev: async () => (await import("./commands/author.ts")).runDev,
	config: async () => (await import("./commands/config.ts")).runConfig,
	// The stdio SDK must stay unloaded for all other CLI commands.
	mcp: async () => (await import("./commands/mcp.ts")).runMcp,
	logs: async () => (await import("./commands/logs.ts")).runLogs,
};

/**
 * Commands whose own output is the point, or that run unattended, log only to `agent.log`; every other
 * command also echoes its log lines to stderr. The agent echoes when attached to a terminal.
 */
function echoLog(command: string): boolean {
	if (command === "agent") return process.stderr.isTTY === true;
	return !["mcp", "status", "doctor", "logs", "dev", "login", "update-watchdog", "config"].includes(command);
}

/** Splits global options (`--data-dir`) from `<command> …args`. */
function parseGlobal(argv: readonly string[]): { dataDir: string | undefined; command: string | undefined; rest: readonly string[] } {
	let dataDir: string | undefined;
	let index = 0;
	for (; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "--data-dir") {
			dataDir = argv[++index];
			if (!dataDir) throw new UsageError("--data-dir needs a path");
		} else if (arg.startsWith("--data-dir=")) {
			dataDir = arg.slice("--data-dir=".length);
			if (!dataDir) throw new UsageError("--data-dir needs a path");
		} else if (arg.startsWith("-") && !["--version", "--help", "-h"].includes(arg)) {
			throw new UsageError(`unknown option ${arg}`);
		} else break;
	}
	return { dataDir, command: argv[index], rest: argv.slice(index + 1) };
}

/** Runs `bgb …argv` and returns the exit code: 0 ok, 1 error, 2 usage, 3 `check` failures. */
export async function main(argv: readonly string[], opts: MainOptions = {}): Promise<number> {
	const io = opts.io ?? consoleIo;
	try {
		const { dataDir, command, rest } = parseGlobal(argv);
		switch (command) {
			case "--version":
				if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
				io.out(BGB_VERSION);
				return 0;
			case undefined:
			case "help":
			case "--help":
			case "-h":
				io.out(USAGE);
				return 0;
		}
		const load = COMMANDS[command];
		if (!load) throw new UsageError(`unknown command "${command}"`);
		// Children (agent, watchdog, autostart) and createContext all resolve DATA from here.
		if (dataDir !== undefined) process.env.BGB_DATA_DIR = path.resolve(dataDir);
		let context: Promise<CoreContext> | undefined;
		const env: CommandEnv = {
			io,
			context: () => {
				context ??= createContext({
					dataDir: process.env.BGB_DATA_DIR || undefined,
					platform: opts.platform,
					log: opts.log,
					echo: echoLog(command),
				});
				return context;
			},
		};
		return await (await load())(env, rest);
	} catch (error) {
		io.err(`bgb: ${errorMessage(error)}`);
		if (error instanceof UsageError) {
			io.err('Run "bgb help" for usage.');
			return 2;
		}
		return 1;
	}
}

if (import.meta.main) {
	const code = await main(process.argv.slice(2));
	process.exit(code);
}

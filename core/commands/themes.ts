// The themes module loads per command (literal specifier, so the compiled binary bundles it).
import * as path from "node:path";
import type { ThemeInfo } from "../../sdk/index.ts";
import { readLiveAgent } from "../agent-record.ts";
import { mutateConfig, readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { BgbError } from "../errors.ts";
import { parseArgs, subcommand } from "./args.ts";
import { type CommandEnv, applyHint } from "./env.ts";

const USAGE = "bgb themes [list] | enable <id> | disable <id> | install <path|url> | uninstall <id>";

async function themes(ctx: CoreContext): Promise<ThemeInfo[]> {
	const { listThemes } = await import("../themes/index.ts");
	return listThemes(ctx, await readConfig(ctx.paths));
}

async function setEnabled(env: CommandEnv, id: string, enabled: boolean): Promise<number> {
	const ctx = await env.context();
	const theme = (await themes(ctx)).find((candidate) => candidate.id === id);
	if (!theme) throw new BgbError("not-found", `no theme with id ${id}`);
	if (enabled && !theme.valid) throw new BgbError("bad-request", `theme ${id} is invalid: ${theme.error ?? "unknown error"}`);
	await mutateConfig(ctx.paths, (config) => {
		const others = config.enabledThemes.filter((enabledId) => enabledId !== id);
		config.enabledThemes = enabled ? [...others, id] : others;
	});
	const live = await readLiveAgent(ctx.paths);
	env.io.out(`${enabled ? "Enabled" : "Disabled"} theme ${id}. ${live ? "Open Grok Bot windows update right away." : await applyHint(ctx)}`);
	return 0;
}

export async function runThemes(env: CommandEnv, argv: readonly string[]): Promise<number> {
	const [sub, rest] = subcommand(argv, ["list", "enable", "disable", "install", "uninstall"], USAGE, "list");
	switch (sub) {
		case "list": {
			parseArgs(rest, { usage: "bgb themes [list]" });
			const list = await themes(await env.context());
			for (const theme of list) {
				const mark = !theme.valid ? "✗" : theme.enabled ? "✓" : "-";
				const about = theme.valid
					? `${theme.name}${theme.version ? ` ${theme.version}` : ""}${theme.description ? ` — ${theme.description}` : ""}`
					: `${theme.name}: ${theme.error ?? "invalid"}`;
				env.io.out(`${mark} ${theme.id}: ${about}`);
			}
			if (list.length === 0) env.io.out(`(no themes; install one with: bgb themes install <path|url>)`);
			return 0;
		}
		case "enable":
		case "disable": {
			const [id = ""] = parseArgs(rest, { min: 1, usage: `bgb themes ${sub} <id>` }).positionals;
			return setEnabled(env, id, sub === "enable");
		}
		case "install": {
			const [source = ""] = parseArgs(rest, { min: 1, usage: "bgb themes install <path|url>" }).positionals;
			const ctx = await env.context();
			const { installTheme } = await import("../themes/index.ts");
			const theme = await installTheme(ctx, /^https?:\/\//i.test(source) ? source : path.resolve(source));
			env.io.out(`Installed theme ${theme.id} (${theme.name}). Enable it with: bgb themes enable ${theme.id}`);
			return 0;
		}
		default: {
			const [id = ""] = parseArgs(rest, { min: 1, usage: "bgb themes uninstall <id>" }).positionals;
			const ctx = await env.context();
			const { uninstallTheme } = await import("../themes/index.ts");
			await uninstallTheme(ctx, id);
			env.io.out(`Uninstalled theme ${id}. ${await applyHint(ctx)}`);
			return 0;
		}
	}
}

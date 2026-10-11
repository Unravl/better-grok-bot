import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { rendererUrl } from "../paths.ts";
import type { HookRecord } from "../platform/types.ts";
import { mutateState, readState } from "../state.ts";
import { type SetupHost, systemHost } from "./host.ts";
import { removePathEntry } from "./path-entry.ts";

const HELPER_LABEL = "io.github.unravl.bettergrokbot.helper";

/**
 * The record of a hook that `hookStatus` reports active although `state.hook` was lost. Its value is
 * this install's URL, so it is ours; a Linux desktop entry is unhooked in place (origin `user-file`).
 */
function lostHookRecord(ctx: CoreContext, host: SetupHost, url: string): HookRecord {
	switch (ctx.platform.id) {
		case "darwin":
			return { kind: "launchctl", value: url };
		case "win32":
			return { kind: "user-env", value: url };
		case "linux": {
			const dataHome = host.env.XDG_DATA_HOME || path.join(host.home, ".local", "share");
			return { kind: "desktop-entry", value: url, path: path.join(dataHome, "applications", "grok-bot.desktop"), origin: "user-file" };
		}
	}
}

async function removeHook(ctx: CoreContext, host: SetupHost): Promise<void> {
	const { paths, platform } = ctx;
	const url = rendererUrl(paths);
	let record = (await readState(paths)).hook;
	if (record === null && (await platform.hookStatus(url, undefined)).state === "active") {
		record = lostHookRecord(ctx, host, url);
	}
	if (record !== null && (await platform.hookRemove(record)) === "not-owned") {
		host.print("The Grok Bot hook was changed by something else; left it untouched.");
	}
	await mutateState(paths, (state) => {
		state.hook = null;
	});
}

async function removeMacHelper(host: SetupHost): Promise<void> {
	// Fails when the helper was never installed or is not loaded.
	await host.exec(["launchctl", "bootout", `gui/${host.uid}/${HELPER_LABEL}`]);
	await rm(path.join(host.home, "Library", "LaunchAgents", `${HELPER_LABEL}.plist`), { force: true });
}

/**
 * `bgb uninstall` (PLAN Step 3.8): stops the agent, removes autostart, the hook (only while it is still
 * ours), the macOS key helper job and the PATH entry, each attempted even when an earlier one fails.
 * `purge` then deletes `DATA`, but only when every step succeeded: a hook left pointing into a deleted
 * `DATA` would leave Grok Bot without a UI. Asks first unless `yes`. Returns the exit code.
 */
export async function runUninstall(
	ctx: CoreContext,
	opts: { purge: boolean; yes: boolean },
	host: SetupHost = systemHost(),
): Promise<number> {
	const { paths, platform } = ctx;
	if (!opts.yes) {
		if (!host.isInteractive()) {
			host.printError("bgb: uninstall asks for confirmation; pass --yes to run it without a terminal");
			return 1;
		}
		const question = opts.purge
			? `Uninstall Better Grok Bot and delete ${paths.root} (plugins, themes, settings)?`
			: "Uninstall Better Grok Bot?";
		if (!(await host.confirm(question, false))) {
			host.print("Nothing changed.");
			return 1;
		}
	}

	const failures: string[] = [];
	const attempt = async (what: string, step: () => Promise<void>): Promise<void> => {
		try {
			await step();
		} catch (error) {
			failures.push(`could not ${what}: ${errorMessage(error)}`);
		}
	};
	await attempt("stop the agent", () => platform.stopAgent(paths));
	await attempt("remove autostart", () => platform.autostartRemove());
	await attempt("remove the Grok Bot hook", () => removeHook(ctx, host));
	if (platform.id === "darwin") await attempt("remove the key helper job", () => removeMacHelper(host));
	await attempt("remove the PATH entry", () => removePathEntry(ctx, host));
	if (failures.length > 0) {
		for (const failure of failures) host.printError(`bgb: ${failure}`);
		if (opts.purge) host.printError(`bgb: kept ${paths.root} because uninstall did not finish; run it again`);
		ctx.log.error(`uninstall incomplete: ${failures.join("; ")}`);
		return 1;
	}
	ctx.log.info(`uninstalled${opts.purge ? "; deleting DATA" : ""}`);

	if (opts.purge) {
		if (platform.id === "win32") {
			// This exe lives in DATA\bin and can't be deleted while it runs: delete DATA once it has exited.
			Bun.spawn(["cmd.exe", "/d", "/c", "ping", "127.0.0.1", "-n", "3", ">", "nul", "&", "rmdir", "/s", "/q", paths.root], {
				cwd: tmpdir(),
				detached: true,
				stdio: ["ignore", "ignore", "ignore"],
				windowsHide: true,
			}).unref();
		} else {
			await rm(paths.root, { recursive: true, force: true });
		}
	}
	host.print("Quit and reopen Grok Bot to finish; it will start without Better Grok Bot.");
	return 0;
}

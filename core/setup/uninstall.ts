import { readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { type DataPaths, rendererUrl } from "../paths.ts";
import type { HookRecord } from "../platform/types.ts";
import { mutateState, readState } from "../state.ts";
import { type SetupHost, systemHost } from "./host.ts";
import { removePathEntry } from "./path-entry.ts";

const HELPER_LABEL = "io.github.unravl.bettergrokbot.helper";

/** The file in the temp folder where the deferred Windows delete records why `DATA` survived. */
export const PURGE_LOG = "bgb-uninstall.log";

/**
 * The detached `cmd.exe` that deletes `dir` (DATA) once this process has exited: it waits about 2 s,
 * runs `rmdir`, and if `dir` survives waits and runs it once more, keeping that attempt's error in
 * `log` only while `dir` still exists. The paths travel in `env` and are read with delayed expansion
 * (`!BGB_PURGE_DIR!`) after cmd has parsed the line, so characters in them (`&`, `%`, `^`, `!`) cannot
 * change the command. Spawn it with `windowsVerbatimArguments` so the quotes reach cmd as written.
 */
export function deferredDeleteCommand(dir: string, log: string): { cmd: string[]; env: Record<string, string> } {
	const wait = "ping -n 3 127.0.0.1 >nul";
	const line = [
		`del /q "!BGB_PURGE_LOG!" 2>nul`,
		wait,
		`rmdir /s /q "!BGB_PURGE_DIR!" 2>nul`,
		`if exist "!BGB_PURGE_DIR!" (${wait} & rmdir /s /q "!BGB_PURGE_DIR!" 2>"!BGB_PURGE_LOG!" & if not exist "!BGB_PURGE_DIR!" del /q "!BGB_PURGE_LOG!")`,
	].join(" & ");
	return { cmd: ["cmd.exe", "/d", "/v:on", "/c", line], env: { BGB_PURGE_DIR: dir, BGB_PURGE_LOG: log } };
}

/**
 * Deletes everything in `DATA` except `bin`, which holds the running exe: the `current` junctions
 * first (unlinked, never followed), then the rest. Windows PowerShell's `Remove-Item -Recurse`
 * mishandles junctions and is slow on build trees, so the deferred delete is left only `bin`.
 * Returns what could not be deleted yet; the deferred delete retries it once this process has exited.
 */
export async function clearDataExceptBin(paths: DataPaths): Promise<string[]> {
	const junctions = [paths.current, `${paths.current}.new`, `${paths.current}.old`];
	const rest = (await readdir(paths.root)).map((name) => path.join(paths.root, name)).filter((entry) => entry !== paths.bin && !junctions.includes(entry));
	const failures: string[] = [];
	for (const entry of [...junctions, ...rest]) {
		try {
			await (junctions.includes(entry) ? unlink(entry) : rm(entry, { recursive: true, force: true }));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(`${entry}: ${errorMessage(error)}`);
		}
	}
	return failures;
}

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

/**
 * Removes the hook and clears `state.hook`. With `purge`, a `not-owned` result is only accepted once
 * the effective hook no longer references this install's URL: a surviving reference keeps the record
 * and throws, so `DATA` (which that hook still loads) is not deleted.
 */
async function removeHook(ctx: CoreContext, host: SetupHost, purge: boolean): Promise<void> {
	const { paths, platform } = ctx;
	const url = rendererUrl(paths);
	let record = (await readState(paths)).hook;
	if (record === null && (await platform.hookStatus(url, undefined)).state === "active") {
		record = lostHookRecord(ctx, host, url);
	}
	if (record !== null && (await platform.hookRemove(record)) === "not-owned") {
		if (purge && (await platform.hookStatus(url, undefined)).state === "active") {
			throw new Error(
				`Grok Bot is still hooked to ${url} by an entry Better Grok Bot does not own; remove VITE_DEV_SERVER_URL from it and run uninstall again`,
			);
		}
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
	await attempt("remove the Grok Bot hook", () => removeHook(ctx, host, opts.purge));
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
			// This exe lives in DATA\bin and can't be deleted while it runs: delete the rest now and DATA
			// once it has exited.
			for (const failure of await clearDataExceptBin(paths)) host.print(`Deleting after exit instead: ${failure}`);
			const deferred = deferredDeleteCommand(paths.root, path.join(tmpdir(), PURGE_LOG));
			Bun.spawn(deferred.cmd, {
				cwd: tmpdir(),
				env: { ...process.env, ...deferred.env },
				detached: true,
				stdio: ["ignore", "ignore", "ignore"],
				windowsHide: true,
				windowsVerbatimArguments: true,
			}).unref();
		} else {
			await rm(paths.root, { recursive: true, force: true });
		}
	}
	host.print("Quit and reopen Grok Bot to finish; it will start without Better Grok Bot.");
	return 0;
}

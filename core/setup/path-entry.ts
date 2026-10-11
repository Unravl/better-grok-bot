import { lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import * as path from "node:path";
import type { CoreContext } from "../context.ts";
import { type SetupHost, systemHost } from "./host.ts";

/** PowerShell that loads the user `Path` into `$parts` (entries) and `$keep` (entries other than `$bin`). */
function windowsPathScript(bin: string): string {
	return [
		`$bin='${bin.replaceAll("'", "''")}'`,
		"$p=[Environment]::GetEnvironmentVariable('Path','User')",
		"$parts=@(if($p){$p -split ';'|Where-Object{$_}})",
		"$keep=@($parts|Where-Object{$_.TrimEnd('\\') -ne $bin.TrimEnd('\\')})",
	].join(";");
}

/**
 * Puts `bgb` on the user's PATH: a `~/.local/bin/bgb` symlink to `DATA/bin/bgb` (replacing a symlink that
 * points elsewhere, never a regular file), or `DATA\bin` appended to the Windows user `Path`. `created`
 * is true when this call changed something; `hint` tells the user what they still need to do.
 */
export async function installPathEntry(
	ctx: CoreContext,
	host: SetupHost = systemHost(),
): Promise<{ created: boolean; hint?: string }> {
	if (ctx.platform.id === "win32") {
		const out = await host.powershell(
			`${windowsPathScript(ctx.paths.bin)};if($keep.Count -ne $parts.Count){'present'}else{[Environment]::SetEnvironmentVariable('Path',(@($parts)+$bin) -join ';','User');'added'}`,
		);
		return out.trim() === "added"
			? { created: true, hint: "Open a new terminal window to use bgb." }
			: { created: false };
	}

	const link = path.join(host.home, ".local", "bin", "bgb");
	const linkDir = path.dirname(link);
	const target = path.join(ctx.paths.bin, ctx.platform.binName());
	const onPath = (host.env.PATH ?? "").split(":").some((dir) => dir !== "" && path.resolve(dir) === linkDir);
	const pathHint = onPath
		? undefined
		: `${linkDir} is not on your PATH; add it to run bgb from any terminal: export PATH="$HOME/.local/bin:$PATH"`;

	const existing = await lstat(link).catch(() => null);
	if (existing !== null && !existing.isSymbolicLink()) {
		return { created: false, hint: `${link} exists and is not a link to Better Grok Bot; left it alone. Run ${target} instead.` };
	}
	if (existing !== null && (await readlink(link)) === target) return { created: false, hint: pathHint };

	await mkdir(linkDir, { recursive: true });
	const temp = `${link}.tmp-${process.pid}`;
	await rm(temp, { force: true });
	await symlink(target, temp);
	await rename(temp, link);
	return { created: true, hint: pathHint };
}

/** Removes the PATH entry, but only a `~/.local/bin/bgb` symlink that points into `DATA/bin`. */
export async function removePathEntry(ctx: CoreContext, host: SetupHost = systemHost()): Promise<void> {
	if (ctx.platform.id === "win32") {
		await host.powershell(
			`${windowsPathScript(ctx.paths.bin)};if($keep.Count -ne $parts.Count){[Environment]::SetEnvironmentVariable('Path',($keep -join ';'),'User')}`,
		);
		return;
	}
	const link = path.join(host.home, ".local", "bin", "bgb");
	const target = await readlink(link).catch(() => null);
	if (target === null) return;
	const relative = path.relative(ctx.paths.bin, path.resolve(path.dirname(link), target));
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return;
	await rm(link, { force: true });
}

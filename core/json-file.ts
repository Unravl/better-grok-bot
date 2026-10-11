import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

/** Parses a JSON file, or returns `undefined` when it does not exist. */
export async function readJsonFile(file: string): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
	}
}

/** Renames `from` over `to`; on Windows retries transient EPERM/EBUSY (a reader holding `to` open). */
export async function renameReplacing(from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY") || attempt >= 10) throw error;
			await Bun.sleep(50);
		}
	}
}

/** Writes JSON through a temp file and an atomic rename, so readers never see a partial file. */
export async function writeJsonAtomic(file: string, value: unknown, opts: { mode?: number } = {}): Promise<void> {
	const temp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
	const mode = process.platform === "win32" ? undefined : opts.mode;
	try {
		await writeFile(temp, `${JSON.stringify(value, null, "\t")}\n`, mode === undefined ? {} : { mode });
		await renameReplacing(temp, file);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

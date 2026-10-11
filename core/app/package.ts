import * as asar from "@electron/asar";
import * as path from "node:path";
import { errorMessage } from "../errors.ts";

/**
 * `@electron/asar` looks entries up by splitting on `path.sep`, so on Windows an archive path must use
 * `\`. Converts a POSIX archive path (`dist/renderer/index.html`) to the form every lookup needs.
 */
export function asarEntry(posixPath: string): string {
	return posixPath.split("/").join(path.sep);
}

/**
 * A bounded semantic-like version: 1–4 numeric parts, optional `-prerelease` and `+build` of dot-separated
 * `[0-9A-Za-z-]` identifiers. It names `DATA/builds/<version>-<key>`, so separators, `..` and anything
 * path-like must never pass.
 */
const APP_VERSION = /^\d{1,9}(?:\.\d{1,9}){0,3}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const APP_VERSION_MAX_LENGTH = 64;

/**
 * Reads `package.json` from a Grok Bot `app.asar`. Drops `@electron/asar`'s cached header first, so an
 * app update that replaced the asar at the same path is read fresh. The version must match
 * {@link APP_VERSION} (at most 64 characters).
 */
export async function readAppPackage(asarPath: string): Promise<{ version: string }> {
	let pkg: unknown;
	try {
		asar.uncache(asarPath);
		pkg = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
	} catch (error) {
		throw new Error(`cannot read package.json from ${asarPath}: ${errorMessage(error)}`);
	}
	const { name, productName, version } = (typeof pkg === "object" && pkg !== null ? pkg : {}) as Record<string, unknown>;
	if (name !== "sand" || productName !== "Grok Bot" || typeof version !== "string") {
		throw new Error(`${asarPath} is not a Grok Bot app.asar`);
	}
	if (version.length > APP_VERSION_MAX_LENGTH || !APP_VERSION.test(version)) {
		throw new Error(`${asarPath} has an invalid version ${JSON.stringify(version.slice(0, APP_VERSION_MAX_LENGTH))}`);
	}
	return { version };
}

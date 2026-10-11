import * as asar from "@electron/asar";
import { errorMessage } from "../errors.ts";

/**
 * Reads `package.json` from a Grok Bot `app.asar`. Drops `@electron/asar`'s cached header first, so an
 * app update that replaced the asar at the same path is read fresh.
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
	return { version };
}

import * as path from "node:path";
import type { CoreContext } from "../context.ts";
import type { AppInstall } from "../platform/types.ts";
import { readAppPackage } from "./package.ts";

/**
 * A path ending in `.asar` is used as-is (`kind: "custom"`, no executable) without the platform adapter;
 * anything else, including `null`, goes through `ctx.platform.locateApp`.
 */
export async function resolveApp(ctx: CoreContext, explicit: string | null): Promise<AppInstall> {
	if (explicit !== null && explicit.toLowerCase().endsWith(".asar")) {
		const asarPath = path.resolve(explicit);
		return { kind: "custom", root: path.dirname(asarPath), executable: "", asarPath, version: (await readAppPackage(asarPath)).version };
	}
	return ctx.platform.locateApp(explicit);
}

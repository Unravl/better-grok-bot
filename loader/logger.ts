import type { PluginLogger } from "../sdk/index.ts";

/** Console logger prefixed `[bgb:<pluginId>]`, or `[bgb]` for the loader itself. */
export function createLogger(pluginId?: string): PluginLogger {
	const prefix = pluginId === undefined ? "[bgb]" : `[bgb:${pluginId}]`;
	return Object.freeze({
		info: (...args: unknown[]) => console.info(prefix, ...args),
		warn: (...args: unknown[]) => console.warn(prefix, ...args),
		error: (...args: unknown[]) => console.error(prefix, ...args),
	});
}

/** One-line message for anything thrown; never throws itself. */
export function describeError(error: unknown): string {
	try {
		if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
		return String(error);
	} catch {
		return "unprintable error";
	}
}

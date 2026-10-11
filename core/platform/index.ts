import type { PlatformAdapter } from "./types.ts";

/**
 * The adapter for this OS. Imported dynamically so only this OS's adapter module evaluates; the
 * specifiers stay string literals so `bun build --compile` still bundles all three.
 */
export async function loadPlatform(): Promise<PlatformAdapter> {
	switch (process.platform) {
		case "darwin":
			return (await import("./darwin.ts")).adapter;
		case "win32":
			return (await import("./win32.ts")).adapter;
		case "linux":
			return (await import("./linux.ts")).adapter;
		default:
			throw new Error(`unsupported OS ${process.platform}`);
	}
}

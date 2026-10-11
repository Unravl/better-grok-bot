import type { PlatformAdapter } from "./types.ts";
import { createUnimplementedAdapter } from "./unimplemented.ts";

/** Placeholder; slice S2 replaces this module with the Linux adapter. */
export const adapter: PlatformAdapter = createUnimplementedAdapter("linux");

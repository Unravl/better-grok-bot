import type { PluginDefinition } from "../../sdk/index.ts";
import { clientHook } from "./client.ts";
import { reactHook } from "./react.ts";
import { settingsHook } from "./settings.ts";

/** Core hooks, always enabled, applied first, in this order. */
export const CORE_HOOKS: readonly PluginDefinition[] = [reactHook, settingsHook, clientHook];

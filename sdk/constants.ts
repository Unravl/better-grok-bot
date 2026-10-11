/** Constants shared by the host (`core/`), the renderer loader and plugins. Browser-safe. */

export const BGB_API_VERSION = 1;
/** Inside `Patch.find`, `\i` matches one minified JS identifier; the patcher rewrites it to this. */
export const IDENTIFIER_PATTERN = "[\\w$]+";
export const RUNTIME_GLOBAL = "BetterGrokBot";
export const BOOT_GLOBAL = "__BGB_BOOT__";
/** Renderer-relative directory holding everything BGB injects. */
export const INJECT_DIR = "assets/bgb";
export const STORAGE_PREFIX = "bgb:";
export const RENDERER_URL_ENV = "VITE_DEV_SERVER_URL";
export const RENDERER_URL_QUERY = "bgb";
export const DEFAULT_BRIDGE_PORT = 39320;
export const BRIDGE_PROTOCOL = 1;
export const HELPER_PROTOCOL = 4;
/** Plugin ids: lowercase kebab-case, length 2–48 (see {@link isValidPluginId}). */
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type Platform = "darwin" | "win32" | "linux";
export type Permission = "keys" | "media" | "mcp";

export const PLATFORMS: readonly Platform[] = ["darwin", "win32", "linux"];
export const PERMISSIONS: readonly Permission[] = ["keys", "media", "mcp"];

/** `bgb` and every `bgb-*` id are reserved for core hooks. */
export function isReservedPluginId(id: string): boolean {
	return id === "bgb" || id.startsWith("bgb-");
}

/** Matches {@link PLUGIN_ID_PATTERN} and is 2–48 characters long. */
export function isValidPluginId(id: string): boolean {
	return id.length >= 2 && id.length <= 48 && PLUGIN_ID_PATTERN.test(id);
}

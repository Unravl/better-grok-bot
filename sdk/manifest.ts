import type { Permission, Platform } from "./constants.ts";
import type { SettingField } from "./plugin.ts";

export type PluginSource = "core" | "bundled" | "community" | "dev";
export type PluginState = "active" | "disabled" | "patch-failed" | "runtime-failed" | "invalid" | "unsupported-platform";

export interface PatchResult {
	id: string;
	/** Renderer-relative paths the patch matched in. */
	files: string[];
	matches: number;
	expected: number;
	ok: boolean;
}

export interface PluginStatus {
	id: string;
	name: string;
	description: string;
	version: string;
	authors: string[];
	source: PluginSource;
	state: PluginState;
	errors: string[];
	patches: PatchResult[];
	permissions: Permission[];
	granted: Permission[];
	settings: Record<string, SettingField>;
	hasRuntime: boolean;
}

export interface ThemeInfo {
	id: string;
	/** The file name when invalid. */
	name: string;
	description?: string;
	author?: string;
	version?: string;
	enabled: boolean;
	valid: boolean;
	error?: string;
}

export interface BuildManifest {
	bgbVersion: string;
	buildFormat: 1;
	buildKey: string;
	platform: Platform;
	appVersion: string;
	appFingerprint: string;
	builtAt: string;
	plugins: PluginStatus[];
	themes: ThemeInfo[];
}

export interface BootPayload {
	manifest: BuildManifest;
	bridge: { port: number; token: string };
	styles: { id: string; kind: "plugin" | "theme"; css: string }[];
}

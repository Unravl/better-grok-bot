/** What the Better Grok Bot settings section shows, as plain data (rendered by `section.ts`). */
import type { BuildManifest, InspectResult, Permission, PluginSource, PluginState, PluginStatus, SettingField, ThemeInfo } from "../../sdk/index.ts";
import type { LoaderSnapshot } from "../store.ts";

export const PERMISSION_MEANINGS: Record<Permission, string> = {
	keys: "listen to a key while Grok Bot is in the background",
	media: "lower other apps' volume",
};

export interface PluginRowModel {
	/** Unique per row (React key): a community or dev plugin may reuse another plugin's id and is then listed as invalid beside it. */
	key: string;
	id: string;
	name: string;
	/** `name`, plus ` · community` / ` · dev`. */
	label: string;
	description: string;
	source: PluginSource;
	state: PluginState;
	/** Toggle position: everything but `disabled` counts as turned on. */
	enabled: boolean;
	/** Invalid and other-OS plugins can't be turned on, so their toggle is inert. */
	canToggle: boolean;
	/** Community plugins get Update and Uninstall. */
	community: boolean;
	granted: Permission[];
	/** Setting rows: only for active plugins. */
	fields: { name: string; field: SettingField }[];
	settings: Record<string, SettingField>;
}

const SOURCE_SUFFIX: Record<PluginSource, string> = { core: "", bundled: "", community: " · community", dev: " · dev" };

export function stateText(state: PluginState, errors: readonly string[]): string {
	switch (state) {
		case "patch-failed":
			return errors[0] ?? "Doesn't fit this Grok Bot version";
		case "runtime-failed":
			return errors[0] ?? "Failed to start";
		case "invalid":
			return errors[0] ?? "Invalid plugin";
		case "unsupported-platform":
			return "Not available on this OS";
		case "active":
		case "disabled":
			return "";
	}
}

/**
 * One row per non-core plugin: from the agent's status when known, else this page's manifest.
 * A plugin this page saw fail at runtime shows `runtime-failed` and its local error, whatever the
 * agent says; the failure is matched by source and id, so an invalid duplicate of the id keeps its
 * own state. Bundled plugins come first, then community and dev plugins, each by name.
 */
export function buildPluginRows(
	agent: readonly PluginStatus[] | null,
	manifest: readonly PluginStatus[],
	local: readonly PluginStatus[],
): PluginRowModel[] {
	const localFailures = new Map(
		local
			.filter((plugin) => plugin.state === "runtime-failed")
			.map((plugin) => [`${plugin.source}:${plugin.id}`, plugin.errors[plugin.errors.length - 1]]),
	);
	const keys = new Map<string, number>();
	return (agent ?? manifest)
		.filter((plugin) => plugin.source !== "core")
		.map((plugin): PluginRowModel => {
			const identity = `${plugin.source}:${plugin.id}`;
			const seen = keys.get(identity) ?? 0;
			keys.set(identity, seen + 1);
			const failedLocally = localFailures.has(identity);
			const state: PluginState = failedLocally ? "runtime-failed" : plugin.state;
			const localError = localFailures.get(identity);
			const errors = failedLocally && localError !== undefined ? [localError] : plugin.errors;
			const detail = stateText(state, errors);
			const settings = state === "active" ? plugin.settings : {};
			return {
				key: seen === 0 ? identity : `${identity}#${seen}`,
				id: plugin.id,
				name: plugin.name,
				label: plugin.name + SOURCE_SUFFIX[plugin.source],
				description: [plugin.description, detail].filter((part) => part !== "").join(" — "),
				source: plugin.source,
				state,
				enabled: state !== "disabled",
				canToggle: state !== "invalid" && state !== "unsupported-platform",
				community: plugin.source === "community",
				granted: [...plugin.granted],
				fields: Object.entries(settings).map(([name, field]) => ({ name, field })),
				settings: { ...plugin.settings },
			};
		})
		.sort((a, b) => Number(a.source !== "bundled") - Number(b.source !== "bundled") || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export interface ThemeRowModel {
	id: string;
	label: string;
	description: string;
	enabled: boolean;
	valid: boolean;
}

export function buildThemeRows(agent: readonly ThemeInfo[] | null, manifest: readonly ThemeInfo[]): ThemeRowModel[] {
	return (agent ?? manifest)
		.map((theme) => ({
			id: theme.id,
			label: theme.name,
			description: theme.valid
				? [theme.description, theme.author === undefined ? undefined : `by ${theme.author}`].filter((part) => part !== undefined && part !== "").join(" · ")
				: (theme.error ?? "Invalid theme"),
			enabled: theme.valid && theme.enabled,
			valid: theme.valid,
		}))
		.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/** "Reload to apply": a newer build is waiting, or the agent has been unreachable for over 10 s (a reload picks up a moved port). */
export function showReloadButton(snapshot: LoaderSnapshot): boolean {
	return snapshot.reloadPending || snapshot.disconnectedLong;
}

export function statusDescription(snapshot: LoaderSnapshot, manifest: BuildManifest): string {
	const parts: string[] = [];
	if (snapshot.bridge === "connected") parts.push("Connected");
	else if (snapshot.bridge === "connecting" && !snapshot.disconnectedLong) parts.push("Connecting to the background agent…");
	else parts.push("Background agent not running — run `bgb start` in a terminal");
	parts.push(`Grok Bot ${manifest.appVersion}`, `build ${manifest.buildKey.slice(0, 12)}`);
	if (snapshot.building) parts.push("rebuilding…");
	else if (snapshot.reloadPending) parts.push("a new build is ready");
	if (snapshot.update?.state === "error" && snapshot.update.error !== undefined) parts.push(`update failed: ${snapshot.update.error}`);
	if (snapshot.notice !== null) parts.push(snapshot.notice);
	return parts.join(" · ");
}

function permissionLines(permissions: readonly Permission[]): string {
	return permissions.map((permission) => `• ${permission}: ${PERMISSION_MEANINGS[permission]}`).join("\n");
}

export function installConfirmMessage(inspected: InspectResult): string {
	const lines = [`Install ${inspected.name} ${inspected.version}?`];
	if (inspected.description !== "") lines.push(inspected.description);
	lines.push("");
	if (inspected.permissions.length === 0) lines.push("It asks for no extra permissions.");
	else lines.push("It asks to:", permissionLines(inspected.permissions));
	if (inspected.replaces !== null) lines.push("", `This replaces version ${inspected.replaces.version}.`);
	lines.push("", "Plugins run inside Grok Bot and can see everything it shows. Install only plugins you trust.");
	return lines.join("\n");
}

export function consentConfirmMessage(name: string, version: string, added: readonly Permission[]): string {
	return [`${name} ${version} asks for new permissions:`, permissionLines(added), "", "Allow them and update?"].join("\n");
}

/** Inline style for the section's own text and number inputs (matches the app's settings controls). */
export const INPUT_STYLE: Readonly<Record<string, string | number>> = Object.freeze({
	font: "inherit",
	color: "inherit",
	background: "transparent",
	border: "1px solid currentColor",
	opacity: 0.8,
	borderRadius: 6,
	padding: "4px 8px",
	width: "12em",
});

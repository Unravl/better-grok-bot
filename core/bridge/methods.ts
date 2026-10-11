/**
 * Handlers for every bridge method (Step 4.2). They validate params, delegate to the build engine,
 * plugins, themes, config, services and self-update, and throw `BgbError` for bridge error codes.
 * Methods that change plugins, themes or settings return once the change is in `DATA`; the rebuild
 * they trigger reports through `build.started`/`build.finished`.
 */
import { mkdir } from "node:fs/promises";
import {
	type AgentStatus,
	type BridgeMethod,
	type BridgeMethods,
	type InspectResult,
	PERMISSIONS,
	type Permission,
	type UpdateStatus,
	isReservedPluginId,
	isValidPluginId,
} from "../../sdk/index.ts";
import type { CoreOps } from "../agent/ops.ts";
import { type Config, mutateConfig, readConfig } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { BgbError } from "../errors.ts";
import { CORE_HOOKS } from "../hooks/index.ts";
import type { MethodHandlers, RendererConnection } from "./server.ts";

export interface MethodDeps {
	ctx: CoreContext;
	ops: Pick<CoreOps, "inspectSource" | "installInspected" | "uninstallPlugin" | "updatePlugin" | "listThemes" | "themeStyles">;
	status(): Promise<AgentStatus>;
	/** A handler committed a config edit; the agent diffs it (rebuild, `themes.changed`, `status.changed`). */
	configChanged(config: Config): Promise<void>;
	/** Plugins under `DATA/plugins` changed; rebuild in the background. */
	pluginsChanged(): void;
	rebuild(force: boolean): void;
	services: {
		watchKeys(connectionId: number, codes: unknown): { unsupported: string[] };
		duck(connectionId: number, level: unknown): void;
		install(): Promise<void>;
	};
	checkUpdate(): Promise<UpdateStatus>;
	/** Resolves once installed (the agent restarts right after answering); throws on failure. */
	applyUpdate(): Promise<void>;
}

type Params = Record<string, unknown>;
type Handler<M extends BridgeMethod> = (params: Params, connection: RendererConnection) => Promise<BridgeMethods[M]["result"]>;

function stringParam(params: Params, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.length === 0) throw new BgbError("bad-request", `${key} must be a non-empty string`);
	return value;
}

function booleanParam(params: Params, key: string): boolean {
	const value = params[key];
	if (typeof value !== "boolean") throw new BgbError("bad-request", `${key} must be true or false`);
	return value;
}

function permissionsParam(params: Params, key: string): Permission[] {
	const value = params[key];
	const known: readonly string[] = PERMISSIONS;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && known.includes(item))) {
		throw new BgbError("bad-request", `${key} must be an array of ${PERMISSIONS.join("/")}`);
	}
	return PERMISSIONS.filter((permission) => value.includes(permission));
}

/** Adds or removes `id` in a sorted, duplicate-free list. */
function toggled(list: readonly string[], id: string, present: boolean): string[] {
	const set = new Set(list);
	if (present) set.add(id);
	else set.delete(id);
	return [...set].sort();
}

export function createMethodHandlers(deps: MethodDeps): MethodHandlers {
	const { ctx, ops } = deps;
	const handlers: { [M in BridgeMethod]: Handler<M> } = {
		"status.get": () => deps.status(),

		"plugins.setEnabled": async (params) => {
			const id = stringParam(params, "id");
			const enabled = booleanParam(params, "enabled");
			if (isReservedPluginId(id) || CORE_HOOKS.some((hook) => hook.id === id)) {
				throw new BgbError("bad-request", `${id} is a core hook and is always enabled`);
			}
			if (!isValidPluginId(id)) throw new BgbError("bad-request", `invalid plugin id ${id}`);
			const config = await mutateConfig(ctx.paths, (draft) => {
				draft.disabledPlugins = toggled(draft.disabledPlugins, id, !enabled);
			});
			await deps.configChanged(config);
			return {};
		},

		"plugins.inspect": async (params) => {
			const inspection = await ops.inspectSource(ctx, stringParam(params, "source"));
			const result: InspectResult = {
				inspectionId: inspection.inspectionId,
				sha256: inspection.sha256,
				id: inspection.json.id,
				name: inspection.json.name,
				version: inspection.json.version,
				description: inspection.json.description,
				permissions: inspection.json.permissions,
				replaces: inspection.replaces,
			};
			return result;
		},

		"plugins.install": async (params) => {
			const result = await ops.installInspected(ctx, stringParam(params, "inspectionId"), {
				acceptPermissions: permissionsParam(params, "acceptPermissions"),
			});
			deps.pluginsChanged();
			return { id: result.id };
		},

		"plugins.uninstall": async (params) => {
			await ops.uninstallPlugin(ctx, stringParam(params, "id"));
			deps.pluginsChanged();
			return {};
		},

		"plugins.update": async (params) => {
			const result = await ops.updatePlugin(ctx, stringParam(params, "id"));
			if (result.state === "updated") deps.pluginsChanged();
			return result;
		},

		"themes.styles": async () => ({ styles: await ops.themeStyles(ctx, await readConfig(ctx.paths)) }),

		"themes.setEnabled": async (params) => {
			const id = stringParam(params, "id");
			const enabled = booleanParam(params, "enabled");
			if (enabled) {
				const theme = (await ops.listThemes(ctx, await readConfig(ctx.paths))).find((candidate) => candidate.id === id);
				if (!theme) throw new BgbError("not-found", `no theme ${id}`);
				if (!theme.valid) throw new BgbError("bad-request", `theme ${id} is invalid: ${theme.error ?? "unreadable"}`);
			}
			const config = await mutateConfig(ctx.paths, (draft) => {
				draft.enabledThemes = toggled(draft.enabledThemes, id, enabled);
			});
			await deps.configChanged(config);
			return {};
		},

		"settings.set": async (params) => {
			const key = params.key;
			if (key !== "openAtLogin" && key !== "autoUpdate") throw new BgbError("bad-request", "key must be openAtLogin or autoUpdate");
			const value = booleanParam(params, "value");
			const config = await mutateConfig(ctx.paths, (draft) => {
				draft[key] = value;
			});
			await deps.configChanged(config);
			return {};
		},

		"build.rebuild": async (params) => {
			const force = params.force ?? false;
			if (typeof force !== "boolean") throw new BgbError("bad-request", "force must be true or false");
			deps.rebuild(force);
			return {};
		},

		"update.check": () => deps.checkUpdate(),

		"update.apply": async () => {
			await deps.applyUpdate();
			return {};
		},

		"system.openPath": async (params) => {
			const target = params.target;
			const dirs = { plugins: ctx.paths.plugins, themes: ctx.paths.themes, logs: ctx.paths.logs };
			if (target !== "plugins" && target !== "themes" && target !== "logs") {
				throw new BgbError("bad-request", "target must be plugins, themes or logs");
			}
			await mkdir(dirs[target], { recursive: true });
			await ctx.platform.openPath(dirs[target]);
			return {};
		},

		"keys.watch": async (params, connection) => deps.services.watchKeys(connection.id, params.codes),

		"keys.install": async () => {
			await deps.services.install();
			return {};
		},

		"media.duck": async (params, connection) => {
			deps.services.duck(connection.id, params.level);
			return {};
		},
	};
	return handlers;
}

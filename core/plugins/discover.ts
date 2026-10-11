import type { Permission, Platform, PluginDefinition, PluginSource } from "../../sdk/index.ts";
import type { Config } from "../config.ts";
import type { CoreContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { BUNDLED_PLUGINS } from "./bundled.ts";
import { type PackageContents, listCommunityPlugins } from "./community.ts";
import { CORE_HOOKS } from "./core.ts";
import { loadDevPlugins } from "./dev.ts";
import type { LoadedPlugin } from "./types.ts";
import { compareNames } from "./package.ts";
import { validateDefinition } from "./validate.ts";

export interface Discovery {
	plugins: LoadedPlugin[];
	/** Problems that keep a plugin out of `plugins` entirely (a dev plugin replacing a community one). */
	warnings: string[];
}

function fromDefinition(
	definition: PluginDefinition,
	source: Extract<PluginSource, "core" | "bundled">,
	enabled: boolean,
	platform: Platform,
	assets: { runtimeJs: string | undefined; stylesCss: string | undefined },
): LoadedPlugin {
	const errors: string[] = [];
	try {
		validateDefinition(definition);
	} catch (error) {
		errors.push(errorMessage(error));
	}
	return {
		id: definition.id,
		source,
		definition: errors.length === 0 ? definition : undefined,
		pkg: undefined,
		runtimeJs: assets.runtimeJs === "" ? undefined : assets.runtimeJs,
		stylesCss: assets.stylesCss === "" ? undefined : assets.stylesCss,
		enabled,
		granted: [...(definition.permissions ?? [])],
		errors,
		state:
			errors.length > 0
				? "invalid"
				: definition.platforms !== undefined && !definition.platforms.includes(platform)
					? "unsupported-platform"
					: enabled
						? undefined
						: "disabled",
	};
}

function fromPackage(
	id: string,
	source: Extract<PluginSource, "community" | "dev">,
	contents: PackageContents | undefined,
	errors: string[],
	config: Config,
	platform: Platform,
): LoadedPlugin {
	const enabled = !config.disabledPlugins.includes(id);
	const pkg = errors.length === 0 ? contents?.pkg : undefined;
	const declared: readonly Permission[] = pkg?.permissions ?? [];
	const granted = (config.grants[id] ?? []).filter((permission) => declared.includes(permission));
	return {
		id,
		source,
		definition: undefined,
		pkg,
		runtimeJs: pkg === undefined ? undefined : contents?.runtimeJs,
		stylesCss: pkg === undefined ? undefined : contents?.stylesCss,
		enabled,
		granted: [...new Set(granted)],
		errors,
		state:
			pkg === undefined
				? "invalid"
				: pkg.platforms !== undefined && !pkg.platforms.includes(platform)
					? "unsupported-platform"
					: enabled
						? undefined
						: "disabled",
	};
}

/**
 * Every plugin in apply order: core hooks (`bgb-react`, `bgb-settings`, `bgb-client`, `bgb-brand`), bundled by id,
 * community by id, dev by id. Core hooks are always enabled. A community or dev id equal to a core or
 * bundled id is `invalid` ("id reserved"); a dev id equal to a community id replaces that plugin (with a
 * warning). Core/bundled plugins hold their declared permissions; community/dev plugins hold
 * `config.grants[id] ∩ declared`. Building dev plugins evaluates their `plugin.ts` on the host.
 */
export async function discoverPlugins(ctx: CoreContext, config: Config, platform: Platform): Promise<Discovery> {
	const plugins: LoadedPlugin[] = [];
	const warnings: string[] = [];
	const reserved = new Set<string>();
	for (const hook of CORE_HOOKS) {
		plugins.push(fromDefinition(hook, "core", true, platform, { runtimeJs: undefined, stylesCss: undefined }));
		reserved.add(hook.id);
	}
	for (const bundled of [...BUNDLED_PLUGINS].sort((a, b) => compareNames(a.definition.id, b.definition.id))) {
		const id = bundled.definition.id;
		plugins.push(
			fromDefinition(bundled.definition, "bundled", !config.disabledPlugins.includes(id), platform, {
				runtimeJs: bundled.runtimeJs,
				stylesCss: bundled.stylesCss,
			}),
		);
		reserved.add(id);
	}

	const dev = await loadDevPlugins(ctx);
	for (const community of await listCommunityPlugins(ctx)) {
		const devPlugin = dev.find((plugin) => plugin.contents !== undefined && plugin.id === community.id);
		if (devPlugin !== undefined) {
			warnings.push(`community plugin "${community.id}" is replaced by the dev plugin in ${devPlugin.sourceDir}`);
			continue;
		}
		const errors = reserved.has(community.id) ? [`id "${community.id}" is reserved`, ...community.errors] : community.errors;
		plugins.push(fromPackage(community.id, "community", community.contents, errors, config, platform));
	}
	for (const plugin of [...dev].sort((a, b) => compareNames(a.id, b.id))) {
		const errors = reserved.has(plugin.id) ? [`id "${plugin.id}" is reserved`, ...plugin.errors] : plugin.errors;
		plugins.push(fromPackage(plugin.id, "dev", plugin.contents, errors, config, platform));
	}
	return { plugins, warnings };
}

import type { Permission, PluginDefinition, PluginPackageJson, PluginSource, PluginState } from "../../sdk/index.ts";

export interface BundledPlugin {
	definition: PluginDefinition;
	runtimeJs: string | undefined;
	stylesCss: string | undefined;
}

export interface LoadedPlugin {
	id: string;
	source: PluginSource;
	/** core, bundled */
	definition: PluginDefinition | undefined;
	/** community, dev */
	pkg: PluginPackageJson | undefined;
	runtimeJs: string | undefined;
	stylesCss: string | undefined;
	enabled: boolean;
	granted: Permission[];
	errors: string[];
	/** Pre-build verdicts: invalid, disabled, unsupported-platform. */
	state: PluginState | undefined;
}

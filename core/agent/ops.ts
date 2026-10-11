/**
 * The build-engine, plugin and theme operations the agent calls (slice S1, CONTRACTS.md). Loaded
 * lazily with literal specifiers (still bundled by `bun build --compile`), so agent tests inject fakes
 * instead of replacing modules process-wide.
 */
import type { BuildManifest, Permission, PluginPackageJson, PluginUpdateResult, ThemeInfo } from "../../sdk/index.ts";
import type { Config } from "../config.ts";
import type { CoreContext } from "../context.ts";
import type { AppInstall } from "../platform/types.ts";

export interface BuildOutcomeInfo {
	key: string;
	dir: string;
	manifest: BuildManifest;
	cached: boolean;
	warnings: string[];
}

export interface InspectionInfo {
	inspectionId: string;
	sha256: string;
	json: PluginPackageJson;
	replaces: { version: string; granted: Permission[]; enabled: boolean } | null;
}

export interface CoreOps {
	build(ctx: CoreContext, options?: { force?: boolean; app?: AppInstall; protect?: string[] }): Promise<BuildOutcomeInfo>;
	readCurrentManifest(ctx: CoreContext): Promise<BuildManifest | null>;
	resolveApp(ctx: CoreContext, explicit: string | null): Promise<AppInstall>;
	inspectSource(ctx: CoreContext, source: string): Promise<InspectionInfo>;
	installInspected(ctx: CoreContext, inspectionId: string, opts: { acceptPermissions: Permission[] }): Promise<{ id: string }>;
	uninstallPlugin(ctx: CoreContext, id: string): Promise<void>;
	updatePlugin(ctx: CoreContext, id: string): Promise<PluginUpdateResult>;
	readDevDirs(ctx: CoreContext): Promise<string[]>;
	listThemes(ctx: CoreContext, config: Config): Promise<ThemeInfo[]>;
	themeStyles(ctx: CoreContext, config: Config): Promise<{ id: string; css: string }[]>;
}

export async function loadCoreOps(): Promise<CoreOps> {
	const [buildModule, resolveModule, installModule, devModule, themesModule] = await Promise.all([
		import("../build/index.ts"),
		import("../app/resolve.ts"),
		import("../plugins/install.ts"),
		import("../plugins/dev.ts"),
		import("../themes/index.ts"),
	]);
	return {
		build: buildModule.build,
		readCurrentManifest: buildModule.readCurrentManifest,
		resolveApp: resolveModule.resolveApp,
		inspectSource: installModule.inspectSource,
		installInspected: installModule.installInspected,
		uninstallPlugin: installModule.uninstallPlugin,
		updatePlugin: installModule.updatePlugin,
		readDevDirs: devModule.readDevDirs,
		listThemes: themesModule.listThemes,
		themeStyles: themesModule.themeStyles,
	};
}

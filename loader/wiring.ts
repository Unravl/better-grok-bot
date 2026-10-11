import type { BuildManifest, PluginLogger, WelcomeFrame } from "../sdk/index.ts";
import type { BridgeClient } from "./bridge-client.ts";
import { describeError } from "./logger.ts";
import type { ServicesClient } from "./services.ts";
import type { LoaderStore } from "./store.ts";
import type { StyleManager } from "./styles.ts";

export interface WiringOptions {
	bridge: BridgeClient;
	store: LoaderStore;
	services: ServicesClient;
	styles: StyleManager;
	manifest: BuildManifest;
	/** `status.get` → store and services. */
	refreshStatus(): Promise<void>;
	reload(): void;
	log: PluginLogger;
}

/**
 * Connects the bridge to the window: live events, and the reconnect sequence after every
 * `welcome` (the agent replays nothing): status, this window's key watch union and duck level,
 * the enabled themes' CSS, then the build-key check. User actions are never replayed.
 */
export function wireBridge(options: WiringOptions): void {
	const { bridge, store, services, styles, manifest, log } = options;

	const refresh = (): void => {
		options.refreshStatus().catch((error: unknown) => log.warn(`could not read the agent status: ${describeError(error)}`));
	};

	const reconnect = (welcome: WelcomeFrame): void => {
		refresh();
		services.resync();
		bridge.request("themes.styles", {}).then(
			({ styles: themes }) => styles.replaceThemes(themes),
			(error: unknown) => log.warn(`could not read the theme styles: ${describeError(error)}`),
		);
		if (welcome.currentBuildKey !== null) store.setCurrentBuildKey(welcome.currentBuildKey);
	};

	bridge.subscribe((state) => store.setBridgeState(state));
	bridge.onWelcome(reconnect);
	bridge.on("status.changed", (status) => {
		store.setStatus(status);
		services.applyStatus(status);
	});
	bridge.on("build.started", () => store.setBuilding(true));
	bridge.on("build.finished", (finished) => {
		store.setBuilding(false);
		if (finished.ok) store.setCurrentBuildKey(finished.buildKey);
		refresh();
	});
	bridge.on("themes.changed", ({ styles: themes }) => styles.replaceThemes(themes));
	bridge.on("update.status", (update) => store.setUpdate(update));
	bridge.on("bridge.moving", () => store.markMoved());
	bridge.on("dev.reload", () => {
		if (manifest.plugins.some((plugin) => plugin.source === "dev")) options.reload();
	});
	store.setBridgeState(bridge.state);
}

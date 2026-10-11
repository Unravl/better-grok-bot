import { appVersionFromUserAgent, RUNTIME_GLOBAL, type BetterGrokBotRuntime, type PluginLogger } from "../sdk/index.ts";
import { captureGlobals, createBridgeClient, offlineBridgeClient, type BridgeClient } from "./bridge-client.ts";
import { systemClock, type Clock } from "./clock.ts";
import { createHookRegistry } from "./hooks.ts";
import { createLogger } from "./logger.ts";
import { migrateGrokModsStorage } from "./migrate.ts";
import { takeBootPayload } from "./payload.ts";
import { createRuntime } from "./runtime.ts";
import { createServicesClient } from "./services.ts";
import { haltIfStaleBuild } from "./stale.ts";
import { getLocalStorage } from "./storage.ts";
import { createLoaderStore } from "./store.ts";
import { createStyleManager } from "./styles.ts";
import { createBgbSection } from "./ui/section.ts";
import { wireBridge } from "./wiring.ts";

/** Seams for tests; the renderer uses the defaults. */
export interface BootOptions {
	global?: typeof globalThis;
	clock?: Clock;
	reload?: () => void;
	stop?: () => void;
	confirm?: (message: string) => boolean;
}

function sessionStore(global: typeof globalThis): Storage | undefined {
	try {
		return global.sessionStorage ?? undefined;
	} catch {
		return undefined;
	}
}

function reportSummary(runtime: BetterGrokBotRuntime, log: PluginLogger): void {
	const plugins = runtime.status();
	const { bgbVersion, appVersion } = runtime.manifest;
	const listing = plugins.map((plugin) => `${plugin.id}@${plugin.version} ${plugin.state}`).join(", ");
	log.info(`Better Grok Bot ${bgbVersion} on Grok Bot ${appVersion}: ${plugins.length} plugin(s)${plugins.length === 0 ? "" : `: ${listing}`}`);
	const failed = plugins.filter((plugin) => plugin.state === "patch-failed" || plugin.state === "runtime-failed");
	if (failed.length > 0) {
		log.warn(
			`${failed.length} plugin(s) failed and are inactive:`,
			failed.map((plugin) => `${plugin.id} (${plugin.state}): ${plugin.errors.join("; ") || "no details"}`).join(" | "),
		);
	}
}

/**
 * The loader's boot sequence. `boot.js` = the boot payload assignment followed by this bundle,
 * run as a classic `<head>` script before the app's first script, so `globalThis.BetterGrokBot`
 * exists synchronously when the plugin scripts that follow call `define()`.
 */
export function boot(options: BootOptions = {}): BetterGrokBotRuntime | undefined {
	const global = options.global ?? globalThis;
	const clock = options.clock ?? systemClock;
	const reload = options.reload ?? (() => global.location.reload());
	const log = createLogger();
	const userAgent = global.navigator?.userAgent ?? "";

	const { manifest, bridge: endpoint, styles } = takeBootPayload(global, userAgent, log);
	const globals = captureGlobals(global);
	const openBridge = (): BridgeClient | null =>
		endpoint === null || typeof globals.WebSocket !== "function"
			? null
			: createBridgeClient({
					port: endpoint.port,
					token: endpoint.token,
					buildKey: manifest.buildKey,
					appVersion: appVersionFromUserAgent(userAgent) ?? "unknown",
					bgbVersion: manifest.bgbVersion,
					globals,
					clock,
					log,
				});

	if (global.BetterGrokBot !== undefined) {
		log.warn("BetterGrokBot is already installed; this loader copy does nothing");
		return undefined;
	}
	const halted = haltIfStaleBuild({
		buildAppVersion: manifest.appVersion,
		userAgent,
		session: sessionStore(global),
		stop: options.stop ?? (() => global.stop()),
		reload,
		clock,
		openBridge,
		log,
	});
	if (halted) return undefined;

	const doc = global.document;
	const bridge = openBridge() ?? offlineBridgeClient();
	const services = createServicesClient(bridge, log);
	const store = createLoaderStore(manifest.buildKey, clock, log);
	const styleManager = createStyleManager(doc);
	const refreshStatus = async (): Promise<void> => {
		const status = await bridge.request("status.get", {});
		store.setStatus(status);
		services.applyStatus(status);
	};

	// The section is built lazily (first Settings render), after `loaded` exists.
	const hooks = createHookRegistry({
		log,
		createSection: (React) =>
			createBgbSection(React, {
				store,
				request: (method, params) => bridge.request(method, params),
				refreshStatus,
				manifest,
				localStatus: () => loaded.runtime.status(),
				settingsFor: (id, fields) => loaded.settingsFor(id, fields),
				reload,
				confirm: options.confirm ?? ((message) => global.confirm(message)),
				log,
			}),
	});
	const loaded = createRuntime({
		manifest,
		hooks,
		services,
		bridgeState: () => bridge.state,
		currentScriptPlugin: () => doc.currentScript?.dataset.bgbPlugin,
		log,
	});
	const { runtime } = loaded;
	Object.defineProperty(global, RUNTIME_GLOBAL, { value: runtime, writable: false, enumerable: false, configurable: true });

	styleManager.inject(styles);
	migrateGrokModsStorage(getLocalStorage(), log);
	wireBridge({ bridge, store, services, styles: styleManager, manifest, refreshStatus, reload, log });
	bridge.start();

	if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", () => reportSummary(runtime, log), { once: true });
	else reportSummary(runtime, log);
	return runtime;
}

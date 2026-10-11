import {
	PermissionError,
	type BetterGrokBotRuntime,
	type BridgeState,
	type BuildManifest,
	type Permission,
	type PluginContext,
	type PluginExports,
	type PluginLogger,
	type PluginServices,
	type PluginSettings,
	type PluginStatus,
	type PluginStorage,
	type SettingField,
	type UiDeps,
	type UiPrimitives,
} from "../sdk/index.ts";
import { createBoundary, jsxFromReact, NullComponent } from "./boundary.ts";
import type { HookRegistry } from "./hooks.ts";
import { createLogger, describeError } from "./logger.ts";
import { isRecord } from "./payload.ts";
import type { ServicesClient } from "./services.ts";
import { createSettings } from "./settings.ts";
import { createStorage } from "./storage.ts";

export interface RuntimeOptions {
	manifest: BuildManifest;
	hooks: HookRegistry;
	services: ServicesClient;
	bridgeState(): BridgeState;
	/** `data-bgb-plugin` of `document.currentScript`: binds a `define()` call to its plugin's script. */
	currentScriptPlugin(): string | undefined;
	log: PluginLogger;
}

export interface LoaderRuntime {
	runtime: BetterGrokBotRuntime;
	/** The settings object a plugin's `ctx.settings` uses (shared with the settings section). */
	settingsFor(id: string, fields: Readonly<Record<string, SettingField>>): PluginSettings;
}

interface LoadedPlugin {
	ctx: PluginContext;
	exports: PluginExports;
}

function isUiDeps(value: Partial<UiDeps>): value is UiDeps {
	const { React, jsx } = value;
	return (
		typeof jsx === "function" &&
		(typeof React === "object" || typeof React === "function") &&
		React !== null &&
		typeof React.Component === "function"
	);
}

export function createRuntime(options: RuntimeOptions): LoaderRuntime {
	const { manifest, hooks, services, log } = options;
	/**
	 * Per id, the entry `define()` binds to: the active one when there is one, else the first. A community or
	 * dev plugin reusing a reserved or taken id is listed as a second, `invalid` entry with the same id; it is
	 * shown by `status()` but must never shadow the plugin that runs.
	 */
	const manifestPlugins = new Map<string, PluginStatus>();
	for (const plugin of manifest.plugins) {
		const known = manifestPlugins.get(plugin.id);
		if (known === undefined || (known.state !== "active" && plugin.state === "active")) manifestPlugins.set(plugin.id, plugin);
	}
	const defined = new Set<string>();
	const loaded = new Map<string, LoadedPlugin>();
	/** Runtime error per plugin downgraded from `active` to `runtime-failed`. */
	const runtimeFailures = new Map<string, string>();
	const reportedCalls = new Set<string>();
	const components = new Map<string, unknown>();
	const storages = new Map<string, PluginStorage>();
	const settingsById = new Map<string, PluginSettings>();
	const loggers = new Map<string, PluginLogger>();

	const loggerFor = (id: string): PluginLogger => {
		let pluginLog = loggers.get(id);
		if (pluginLog === undefined) {
			pluginLog = createLogger(id);
			loggers.set(id, pluginLog);
		}
		return pluginLog;
	};

	const storageFor = (id: string): PluginStorage => {
		let storage = storages.get(id);
		if (storage === undefined) {
			storage = createStorage(id, loggerFor(id));
			storages.set(id, storage);
		}
		return storage;
	};

	const settingsFor = (id: string, fields: Readonly<Record<string, SettingField>>): PluginSettings => {
		let settings = settingsById.get(id);
		if (settings === undefined) {
			settings = createSettings(id, fields, storageFor(id));
			settingsById.set(id, settings);
		}
		return settings;
	};

	const servicesFor = (id: string, granted: readonly Permission[]): PluginServices =>
		Object.freeze({
			get keys() {
				if (!granted.includes("keys")) throw new PermissionError(id, "keys");
				return services.keysFor(id);
			},
			get media() {
				if (!granted.includes("media")) throw new PermissionError(id, "media");
				return services.mediaFor(id);
			},
		});

	const markRuntimeFailed = (id: string, message: string, error?: unknown): void => {
		runtimeFailures.set(id, message);
		log.error(`plugin "${id}" failed to start: ${message}`, ...(error === undefined ? [] : [error]));
	};

	const resolveComponent = (id: string, name: string, deps: UiDeps): unknown => {
		const label = `BetterGrokBot(${id}.${name})`;
		const plugin = loaded.get(id);
		if (plugin === undefined) {
			log.warn(`${label}: plugin "${id}" is not loaded; rendering nothing`);
			return NullComponent;
		}
		const factory = Object.hasOwn(plugin.exports, name) ? plugin.exports[name] : undefined;
		if (typeof factory !== "function") {
			plugin.ctx.log.error(`${label}: export "${name}" is ${factory === undefined ? "missing" : "not a function"}; rendering nothing`);
			return NullComponent;
		}
		let inner: unknown;
		try {
			inner = Reflect.apply(factory, plugin.exports, [deps, plugin.ctx]);
		} catch (error) {
			plugin.ctx.log.error(`${label}: component factory threw; rendering nothing:`, error);
			return NullComponent;
		}
		if (typeof inner !== "function") {
			plugin.ctx.log.error(`${label}: component factory did not return a component; rendering nothing`);
			return NullComponent;
		}
		return createBoundary(deps.React, deps.jsx, inner, label, plugin.ctx.log);
	};

	const runtime: BetterGrokBotRuntime = {
		version: manifest.bgbVersion,
		manifest,
		get React() {
			return hooks.React;
		},

		define(id: string, factory: (ctx: PluginContext) => PluginExports): void {
			try {
				if (defined.has(id)) {
					log.warn(`ignoring duplicate define() for plugin "${id}"`);
					return;
				}
				const plugin = manifestPlugins.get(id);
				if (plugin === undefined) {
					log.warn(`ignoring define() for plugin "${id}": not in this build's manifest`);
					return;
				}
				if (plugin.state !== "active") {
					log.warn(`ignoring define() for plugin "${id}": its state is ${plugin.state}`);
					return;
				}
				if (options.currentScriptPlugin() !== id) {
					log.warn(`ignoring define() for plugin "${id}": it must be called synchronously from that plugin's own script`);
					return;
				}
				defined.add(id);
				const ctx: PluginContext = Object.freeze({
					id,
					log: loggerFor(id),
					storage: storageFor(id),
					settings: settingsFor(id, plugin.settings),
					manifest,
					app: hooks.app,
					services: servicesFor(id, plugin.granted),
				});
				let exports: unknown;
				try {
					if (typeof factory !== "function") throw new TypeError("define() needs a factory function");
					exports = factory(ctx);
				} catch (error) {
					markRuntimeFailed(id, `runtime threw: ${describeError(error)}`, error);
					return;
				}
				if (!isRecord(exports)) {
					markRuntimeFailed(id, "runtime factory did not return an exports object");
					return;
				}
				loaded.set(id, { ctx, exports });
			} catch (error) {
				log.error(`define() for plugin "${id}" failed:`, error);
			}
		},

		call(id: string, name: string, ...args: unknown[]): unknown {
			const callKey = JSON.stringify([id, name]);
			const plugin = loaded.get(id);
			const fn = plugin !== undefined && Object.hasOwn(plugin.exports, name) ? plugin.exports[name] : undefined;
			if (plugin !== undefined && typeof fn === "function") {
				try {
					const result: unknown = Reflect.apply(fn, plugin.exports, args);
					return result;
				} catch (error) {
					if (!reportedCalls.has(callKey)) {
						reportedCalls.add(callKey);
						plugin.ctx.log.error(`call("${name}") threw; the app falls back to its default:`, error);
					}
					return undefined;
				}
			}
			if (!reportedCalls.has(callKey)) {
				reportedCalls.add(callKey);
				if (plugin === undefined) log.warn(`call("${id}", "${name}"): plugin is not loaded`);
				else plugin.ctx.log.warn(`call("${name}"): export is ${fn === undefined ? "missing" : "not a function"}`);
			}
			return undefined;
		},

		component(id: string, name: string, deps: Partial<UiDeps> = {}): unknown {
			const componentKey = JSON.stringify([id, name]);
			try {
				const cached = components.get(componentKey);
				if (cached !== undefined) return cached;
				const React = deps.React ?? hooks.React;
				if (React === undefined) {
					// Not cached: the app's React may still arrive.
					log.error(`BetterGrokBot(${id}.${name}): no React yet; rendering nothing`);
					return NullComponent;
				}
				const full: Partial<UiDeps> = { ...deps, React, jsx: deps.jsx ?? jsxFromReact(React) };
				let component: unknown = NullComponent;
				if (isUiDeps(full)) component = resolveComponent(id, name, full);
				else log.error(`BetterGrokBot(${id}.${name}): deps must provide React.Component and jsx; rendering nothing`);
				components.set(componentKey, component);
				return component;
			} catch (error) {
				log.error(`BetterGrokBot(${id}.${name}): could not be built; rendering nothing:`, error);
				components.set(componentKey, NullComponent);
				return NullComponent;
			}
		},

		status(): PluginStatus[] {
			return manifest.plugins.map((plugin) => {
				const runtimeError = manifestPlugins.get(plugin.id) === plugin ? runtimeFailures.get(plugin.id) : undefined;
				return {
					...plugin,
					state: runtimeError === undefined ? plugin.state : "runtime-failed",
					errors: runtimeError === undefined ? [...plugin.errors] : [...plugin.errors, runtimeError],
					patches: plugin.patches.map((patch) => ({ ...patch, files: [...patch.files] })),
					permissions: [...plugin.permissions],
					granted: [...plugin.granted],
					authors: [...plugin.authors],
					settings: { ...plugin.settings },
				};
			});
		},

		bridgeState: () => options.bridgeState(),
		provideReact: (react: unknown) => hooks.provideReact(react),
		provideClient: <T>(client: T): T => hooks.provideClient(client),
		settingsSection: (ui: UiPrimitives) => hooks.settingsSection(ui),
	};

	return { runtime: Object.freeze(runtime), settingsFor };
}

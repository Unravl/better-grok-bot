import type { AppAccess, JsxFn, PluginLogger, ReactLike, UiPrimitives } from "../sdk/index.ts";
import { createBoundary, jsxFromReact } from "./boundary.ts";
import { isRecord } from "./payload.ts";

/** Receives what the core hooks (`bgb-react`, `bgb-client`, `bgb-settings`) hand over from the app. */
export interface HookRegistry {
	readonly React: ReactLike | undefined;
	readonly app: AppAccess;
	/** First valid call wins. Never throws. */
	provideReact(react: unknown): undefined;
	/** A non-null client with a new identity replaces the current one; returns its argument. Never throws. */
	provideClient<T>(client: T): T;
	/** The Better Grok Bot section element, or null. Never throws. */
	settingsSection(ui: UiPrimitives): unknown;
}

export interface HookRegistryOptions {
	log: PluginLogger;
	/** Builds the settings section component once, from the app's React. */
	createSection(React: ReactLike, jsx: JsxFn): unknown;
	/** Defaults to `queueMicrotask`. */
	schedule?: (task: () => void) => void;
}

function isReactLike(value: unknown): value is ReactLike {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof Reflect.get(value, "createElement") === "function" &&
		typeof Reflect.get(value, "Component") === "function" &&
		typeof Reflect.get(value, "useSyncExternalStore") === "function"
	);
}

function isUiPrimitives(value: unknown): value is UiPrimitives {
	return (
		isRecord(value) &&
		value.Section != null &&
		value.Row != null &&
		value.Toggle != null &&
		value.Select != null &&
		value.Button != null &&
		isRecord(value.textStyles)
	);
}

interface ClientListener {
	listener(client: unknown): void;
	last: unknown;
	active: boolean;
}

export function createHookRegistry(options: HookRegistryOptions): HookRegistry {
	const { log } = options;
	const schedule = options.schedule ?? ((task: () => void) => queueMicrotask(task));
	let react: ReactLike | undefined;
	let jsx: JsxFn | undefined;
	let ui: UiPrimitives | undefined;
	let client: unknown;
	let section: unknown;
	const reported = new Set<string>();
	const clientListeners = new Set<ClientListener>();

	/** Logs each settings-section problem once (the page re-renders often) and yields the fallback. */
	const reportOnce = (message: string, error?: unknown): null => {
		if (!reported.has(message)) {
			reported.add(message);
			log.error(message, ...(error === undefined ? [] : [error]));
		}
		return null;
	};

	const deliver = (entry: ClientListener, next: unknown): void => {
		if (!entry.active || entry.last === next) return;
		entry.last = next;
		try {
			entry.listener(next);
		} catch (error) {
			log.error("onClient listener threw:", error);
		}
	};

	const app: AppAccess = Object.freeze({
		get React() {
			return react;
		},
		get jsx() {
			return jsx;
		},
		get ui() {
			return ui;
		},
		get client() {
			return client;
		},
		onClient(listener: (client: unknown) => void): () => void {
			const entry: ClientListener = { listener, last: undefined, active: true };
			clientListeners.add(entry);
			if (client !== undefined) {
				const current = client;
				schedule(() => {
					if (client === current) deliver(entry, current);
				});
			}
			return () => {
				entry.active = false;
				clientListeners.delete(entry);
			};
		},
	});

	return Object.freeze({
		get React() {
			return react;
		},
		app,

		provideReact(value: unknown): undefined {
			try {
				if (react !== undefined) return undefined;
				if (!isReactLike(value)) {
					log.error("provideReact: the app's React namespace is missing createElement/Component; ignoring it");
					return undefined;
				}
				react = value;
				jsx = jsxFromReact(value);
			} catch (error) {
				log.error("provideReact failed:", error);
			}
			return undefined;
		},

		provideClient<T>(next: T): T {
			try {
				if (next === null || next === undefined || next === client) return next;
				client = next;
				schedule(() => {
					for (const entry of [...clientListeners]) deliver(entry, next);
				});
			} catch (error) {
				log.error("provideClient failed:", error);
			}
			return next;
		},

		settingsSection(next: UiPrimitives): unknown {
			try {
				if (react === undefined || jsx === undefined) return reportOnce("the settings section needs the app's React, which never arrived");
				if (!isUiPrimitives(next)) return reportOnce("the settings section got incomplete UI primitives");
				ui = next;
				section ??= createBoundary(react, jsx, options.createSection(react, jsx), "BetterGrokBot(settings)", log);
				return react.createElement(section, { key: "bgb", ui: next });
			} catch (error) {
				return reportOnce("the settings section failed:", error);
			}
		},
	});
}

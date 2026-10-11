import type { Permission } from "./constants.ts";
import type { BootPayload, BuildManifest, PluginStatus } from "./manifest.ts";
import type { SettingField } from "./plugin.ts";

export interface PluginLogger {
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

/** JSON values persisted in `localStorage` under `bgb:<pluginId>:<key>`. */
export interface PluginStorage {
	get<T>(key: string, fallback: T): T;
	set(key: string, value: unknown): void;
	/** Fires after `set` in this window and on `storage` events from other windows. */
	subscribe(key: string, listener: () => void): () => void;
}

export interface ReactComponentInstance {
	props: Record<string, unknown>;
	state: unknown;
	setState(state: unknown): void;
}

/** Minimal shape of the app's bundled React namespace. */
export interface ReactLike {
	Component: new (props: Record<string, unknown>) => ReactComponentInstance;
	Fragment: unknown;
	createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
	useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void];
	useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
	useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
	useRef<T>(initial: T): { current: T };
	useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T;
	useSyncExternalStore<T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T): T;
}

/** The app's `jsx` runtime function: `jsx(type, props, key?)`. */
export type JsxFn = (type: unknown, props: Record<string, unknown>, key?: string) => unknown;

export type SettingValue = boolean | number | string;

/**
 * Schema-backed plugin settings stored under `setting:<name>`.
 * `get`: the stored value when valid for its field, else the default.
 * `set`: throws `RangeError` for an unknown key or an invalid value.
 */
export interface PluginSettings {
	get(key: string): SettingValue;
	set(key: string, value: SettingValue): void;
	subscribe(key: string, listener: () => void): () => void;
}

/** Settings-page primitives captured from the app by the `bgb-settings` core hook. */
export interface UiPrimitives {
	Section: unknown;
	Row: unknown;
	Toggle: unknown;
	Select: unknown;
	Button: unknown;
	textStyles: Record<string, unknown>;
}

export interface AppAccess {
	readonly React: ReactLike | undefined;
	readonly jsx: JsxFn | undefined;
	readonly ui: UiPrimitives | undefined;
	/** Latest non-null SandClient. */
	readonly client: unknown;
	/** Called in a microtask with the current client if one exists, then on every client identity change. */
	onClient(listener: (client: unknown) => void): () => void;
}

export type KeysState = "unsupported" | "needs-install" | "installing" | "starting" | "needs-permission" | "ready" | "error";

export interface KeysService {
	readonly state: KeysState;
	readonly detail: string | undefined;
	/** `listener(false)` also fires when the bridge or helper connection drops while the key is down. */
	watch(code: string, listener: (down: boolean) => void): () => void;
	onChord(listener: (code: string) => void): () => void;
	install(): Promise<void>;
	subscribe(listener: () => void): () => void;
}

export type MediaState = "unsupported" | "needs-install" | "ready" | "error";

export interface MediaService {
	readonly state: MediaState;
	readonly detail: string | undefined;
	/** Level 0..1; 1 releases. */
	duck(level: number): void;
	subscribe(listener: () => void): () => void;
}

/** Property access without a grant throws {@link PermissionError}. */
export interface PluginServices {
	readonly keys: KeysService;
	readonly media: MediaService;
}

export class PermissionError extends Error {
	constructor(
		readonly pluginId: string,
		readonly permission: Permission,
	) {
		super(`plugin ${pluginId} lacks permission ${permission}`);
		this.name = "PermissionError";
	}
}

export interface PluginContext {
	readonly id: string;
	readonly log: PluginLogger;
	readonly storage: PluginStorage;
	readonly settings: PluginSettings;
	readonly manifest: BuildManifest;
	readonly app: AppAccess;
	readonly services: PluginServices;
}

export type PluginExports = Record<string, unknown>;

export interface UiDeps {
	React: ReactLike;
	jsx: JsxFn;
	[dependency: string]: unknown;
}

export type ComponentFactory = (deps: UiDeps, ctx: PluginContext) => (props: Record<string, unknown>) => unknown;

export type BridgeState = "connecting" | "connected" | "disconnected";

export interface BetterGrokBotRuntime {
	readonly version: string;
	readonly manifest: BuildManifest;
	readonly React: ReactLike | undefined;
	define(id: string, factory: (ctx: PluginContext) => PluginExports): void;
	/** Never throws. */
	call(id: string, name: string, ...args: unknown[]): unknown;
	/** Never throws; React/jsx default to core React. */
	component(id: string, name: string, deps?: Partial<UiDeps>): unknown;
	status(): PluginStatus[];
	bridgeState(): BridgeState;
	/** Core hook `bgb-react`; first call wins; never throws. */
	provideReact(react: unknown): void;
	/** Core hook `bgb-client`; latest non-null client wins; returns its argument; never throws. */
	provideClient<T>(client: T): T;
	/** Core hook `bgb-settings`; a React element, or null on any failure; never throws. */
	settingsSection(ui: UiPrimitives): unknown;
}

declare global {
	var BetterGrokBot: BetterGrokBotRuntime | undefined;
	var __BGB_BOOT__: BootPayload | undefined;
}

/** A stored setting is valid when its type matches the field (see `SettingField`). */
export function isValidSettingValue(field: SettingField, value: unknown): value is SettingValue {
	switch (field.type) {
		case "boolean":
			return typeof value === "boolean";
		case "number":
			return (
				typeof value === "number" &&
				Number.isFinite(value) &&
				(field.min === undefined || value >= field.min) &&
				(field.max === undefined || value <= field.max)
			);
		case "select":
			return typeof value === "string" && field.options.some((option) => option.value === value);
		case "string":
			return typeof value === "string";
		case "key":
			return typeof value === "string" && value.length > 0;
	}
}

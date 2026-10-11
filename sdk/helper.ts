/** Agent ↔ native helper protocol v4 (`ws://127.0.0.1:<port>/helper`, `Authorization: Bearer <bridgeToken>`). */
import type { Platform } from "./constants.ts";

export type HelperKeysAccess = "unsupported" | "denied" | "granted";

export type HelperToAgent =
	| { type: "hello"; protocol: 4; platform: Platform; keys: HelperKeysAccess; codes: string[]; media: boolean }
	| { type: "access"; keys: "denied" | "granted" }
	| { type: "key"; code: string; down: boolean }
	| { type: "chord"; code: string }
	| { type: "log"; level: "info" | "warn" | "error"; message: string };

export type AgentToHelper =
	| { type: "watch"; codes: string[] }
	/** 0–1; release = `{ducked:false, level:1}`. */
	| { type: "duck"; ducked: boolean; level: number }
	| { type: "quit" };

const MODIFIER_CODES = ["AltLeft", "AltRight", "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"] as const;
const FUNCTION_CODES = Array.from({ length: 24 }, (_, index) => `F${index + 1}`);
const LOCK_CODES = ["CapsLock", "NumLock", "ScrollLock"] as const;
const MISC_CODES = ["Pause", "Insert", "ContextMenu"] as const;
const MEDIA_CODES = ["MediaPlayPause", "MediaStop", "MediaTrackNext", "MediaTrackPrevious", "AudioVolumeMute"] as const;

/** Modifier codes (helpers initialize them from hardware state when added to a watch set). */
export const MODIFIER_KEY_CODES: ReadonlySet<string> = new Set<string>([...MODIFIER_CODES, "Fn"]);

/**
 * The only codes that may be watched in the background. The bridge never carries
 * system-wide character-key events.
 */
export const WATCHABLE_CODES: ReadonlySet<string> = new Set<string>([
	...MODIFIER_CODES,
	"Fn",
	...LOCK_CODES,
	...FUNCTION_CODES,
	...MISC_CODES,
	...MEDIA_CODES,
]);

const NON_MAC_CODES: readonly string[] = [...WATCHABLE_CODES].filter((code) => code !== "Fn");

/** Codes each OS helper implements; every helper keymap covers exactly its list. */
export const HELPER_CODES: Readonly<Record<Platform, readonly string[]>> = {
	darwin: [...MODIFIER_CODES, "Fn", ...FUNCTION_CODES.slice(0, 20)],
	win32: NON_MAC_CODES,
	linux: NON_MAC_CODES,
};

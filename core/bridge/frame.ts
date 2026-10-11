import { isSidebarError, isSidebarResult, type BridgeError, type BridgeErrorCode, type SidebarResponseFrame } from "../../sdk/index.ts";
import { BgbError } from "../errors.ts";

/** A parsed JSON text frame: an object with a string `type`; every other field is still unchecked. */
export interface Frame {
	type: string;
	[field: string]: unknown;
}

/** Parses one bridge text frame; `null` when it is not JSON or has no string `type`. */
export function parseFrame(raw: string | Buffer): Frame | null {
	let value: unknown;
	try {
		value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") return null;
	// Only `type` is checked here; each consumer checks the fields it reads.
	const frame: Frame = value as Frame;
	return frame;
}

const ERROR_CODES: readonly BridgeErrorCode[] = ["bad-request", "not-found", "conflict", "permission-denied", "unavailable", "internal"];
const SIDEBAR_SUCCESS_KEYS: Record<string, true> = { type: true, id: true, ok: true, result: true };
const SIDEBAR_FAILURE_KEYS: Record<string, true> = { type: true, id: true, ok: true, error: true };
const SIDEBAR_ERROR_KEYS: Record<string, true> = { code: true, message: true, data: true };

/** Keeps browser-safe sidebar and host errors intact across the wire. */
export function toBridgeError(error: unknown): BridgeError {
	if (error instanceof BgbError || isSidebarError(error)) {
		return error.data === undefined
			? { code: error.code, message: error.message }
			: { code: error.code, message: error.message, data: error.data };
	}
	return { code: "internal", message: error instanceof Error ? error.message : String(error) };
}

/** The `BgbError` for a response's `error` field (unknown codes become `internal`). */
export function fromBridgeError(error: unknown): BgbError {
	if (typeof error !== "object" || error === null) return new BgbError("internal", "request failed");
	const code = "code" in error && typeof error.code === "string" ? error.code : "internal";
	const message = "message" in error && typeof error.message === "string" ? error.message : "request failed";
	const data = "data" in error ? error.data : undefined;
	const known = ERROR_CODES.find((candidate) => candidate === code) ?? "internal";
	return new BgbError(known, message, data);
}

/** Reverse replies have a finite envelope and a validated sidebar result or wire error. */
export function parseSidebarResponse(frame: Frame): SidebarResponseFrame | null {
	if (frame.type !== "sidebar.res" || typeof frame.id !== "number" || !Number.isSafeInteger(frame.id) || frame.id <= 0) return null;
	if (frame.ok === true) {
		if (Object.keys(frame).some((key) => !Object.hasOwn(SIDEBAR_SUCCESS_KEYS, key)) || !isSidebarResult(frame.result)) return null;
		return { type: "sidebar.res", id: frame.id, ok: true, result: frame.result };
	}
	if (frame.ok !== false || Object.keys(frame).some((key) => !Object.hasOwn(SIDEBAR_FAILURE_KEYS, key))) return null;
	const error = frame.error;
	if (
		typeof error !== "object" || error === null || Array.isArray(error) ||
		!("code" in error) || !ERROR_CODES.some((code) => code === error.code) ||
		!("message" in error) || typeof error.message !== "string" ||
		Object.keys(error).some((key) => !Object.hasOwn(SIDEBAR_ERROR_KEYS, key))
	) return null;
	return { type: "sidebar.res", id: frame.id, ok: false, error: toBridgeError(fromBridgeError(error)) };
}

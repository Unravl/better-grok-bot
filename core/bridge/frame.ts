import type { BridgeError, BridgeErrorCode } from "../../sdk/index.ts";
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

/** Maps a thrown value to the wire error: `BgbError` keeps its code and data, anything else is `internal`. */
export function toBridgeError(error: unknown): BridgeError {
	if (error instanceof BgbError) {
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

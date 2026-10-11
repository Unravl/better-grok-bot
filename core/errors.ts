import type { BridgeErrorCode } from "../sdk/index.ts";

/** An error carrying a bridge error code; the bridge maps it to `{ok:false, error:{code, message, data}}`. */
export class BgbError extends Error {
	constructor(
		readonly code: BridgeErrorCode,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "BgbError";
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

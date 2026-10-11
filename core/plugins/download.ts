import { BGB_VERSION } from "../version.ts";
import { BgbError, errorMessage } from "../errors.ts";

export const USER_AGENT = `better-grok-bot/${BGB_VERSION}`;

/**
 * GETs `url` into memory, refusing bodies over `maxBytes` (by `Content-Length` up front, then while
 * streaming). Network failures and non-2xx answers → `unavailable` (404 → `not-found`); too large →
 * `bad-request`.
 */
export async function downloadBytes(
	url: string,
	opts: { maxBytes: number; signal: AbortSignal; headers?: Record<string, string>; what?: string },
): Promise<Uint8Array> {
	const what = opts.what ?? url;
	let response: Response;
	try {
		response = await fetch(url, { signal: opts.signal, headers: { "User-Agent": USER_AGENT, ...opts.headers } });
	} catch (error) {
		throw new BgbError("unavailable", `cannot download ${what}: ${errorMessage(error)}`);
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new BgbError(response.status === 404 ? "not-found" : "unavailable", `cannot download ${what}: HTTP ${response.status}`);
	}
	const tooLarge = (): BgbError => new BgbError("bad-request", `${what} is larger than ${Math.round(opts.maxBytes / 1024 / 1024)} MB`);
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > opts.maxBytes) {
		await response.body?.cancel();
		throw tooLarge();
	}
	if (response.body === null) return new Uint8Array(0);
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = response.body.getReader();
	try {
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
			total += chunk.value.byteLength;
			if (total > opts.maxBytes) {
				await reader.cancel();
				break;
			}
			chunks.push(chunk.value);
		}
	} catch (error) {
		throw new BgbError("unavailable", `cannot download ${what}: ${errorMessage(error)}`);
	}
	if (total > opts.maxBytes) throw tooLarge();
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

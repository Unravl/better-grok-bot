import { createHash } from "node:crypto";
import { BGB_VERSION } from "../version.ts";

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Headers for GitHub requests (the API rejects requests without a User-Agent). */
export function githubHeaders(): Record<string, string> {
	return { "User-Agent": `better-grok-bot/${BGB_VERSION}`, Accept: "application/vnd.github+json" };
}

/** GETs `url` into memory; throws on a non-2xx status, on timeout and when the body exceeds `maxBytes`. */
export async function fetchBytes(
	fetchFn: FetchFn,
	url: string,
	opts: { timeoutMs: number; maxBytes: number },
): Promise<Uint8Array> {
	const response = await fetchFn(url, { headers: githubHeaders(), signal: AbortSignal.timeout(opts.timeoutMs) });
	if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > opts.maxBytes) {
		throw new Error(`GET ${url}: ${declared} bytes exceeds the ${opts.maxBytes}-byte limit`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > opts.maxBytes) throw new Error(`GET ${url}: body exceeds the ${opts.maxBytes}-byte limit`);
	return bytes;
}

/** Downloads `url` and checks it against `sha256` (lowercase hex). */
export async function fetchVerified(
	fetchFn: FetchFn,
	url: string,
	sha256: string,
	opts: { timeoutMs: number; maxBytes: number },
): Promise<Uint8Array> {
	const bytes = await fetchBytes(fetchFn, url, opts);
	const actual = sha256Hex(bytes);
	if (actual !== sha256.toLowerCase()) throw new Error(`checksum mismatch for ${url} (expected ${sha256}, got ${actual})`);
	return bytes;
}

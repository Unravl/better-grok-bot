/** Time source for everything in the loader that waits, so tests can drive time by hand. */
export interface Clock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = Object.freeze({
	now: () => Date.now(),
	setTimeout: (callback: () => void, ms: number): unknown => globalThis.setTimeout(callback, ms),
	clearTimeout: (handle: unknown): void => globalThis.clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
});

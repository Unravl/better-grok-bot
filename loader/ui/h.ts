import type { ReactLike } from "../../sdk/index.ts";

export type H = (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;

/**
 * `createElement` bound to the app's React (the loader has no JSX transform). `false`, `null` and
 * `undefined` children are dropped, so `condition && element` reads naturally.
 */
export function createH(React: ReactLike): H {
	return (type, props = null, ...children) =>
		React.createElement(type, props, ...children.filter((child) => child !== false && child !== null && child !== undefined));
}

import type { JsxFn, PluginLogger, ReactLike } from "../sdk/index.ts";

/** Stand-in for any component that cannot be built: renders nothing. */
export const NullComponent = (): null => null;

interface BoundaryState {
	failed: boolean;
}

/**
 * Wraps a component in an error boundary built from the app's own React. A crash is sticky for
 * this component: the crashing instance and every later instance render `null`, so a broken
 * plugin cannot keep re-throwing into React.
 */
export function createBoundary(React: ReactLike, jsx: JsxFn, inner: unknown, label: string, log: PluginLogger): unknown {
	let failed = false;
	let reported = false;

	class BetterGrokBotBoundary extends React.Component {
		static displayName = label;

		static getDerivedStateFromError(): BoundaryState {
			failed = true;
			return { failed: true };
		}

		constructor(props: Record<string, unknown>) {
			super(props);
			const state: BoundaryState = { failed };
			this.state = state;
		}

		componentDidCatch(error: unknown): void {
			if (reported) return;
			reported = true;
			log.error(`${label} crashed and now renders nothing:`, error);
		}

		render(): unknown {
			// `failed` is shared and set before React re-renders a caught boundary.
			return failed ? null : jsx(inner, this.props);
		}
	}

	return BetterGrokBotBoundary;
}

/** `jsx(type, props, key)` on top of `React.createElement`, for callers that have no `jsx` runtime. */
export function jsxFromReact(React: ReactLike): JsxFn {
	return (type, props, key) => React.createElement(type, key === undefined ? props : { ...props, key });
}

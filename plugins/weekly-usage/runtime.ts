/**
 * Weekly usage bar in the sidebar footer, directly above Connect Apps.
 *
 * Reuses the app's own usage source: the client's `usageSummary` store (the one behind Settings → Usage,
 * read there through `useSyncExternalStore(client.usageSummary.snapshots…)`), which the app fills from
 * `desktop.getCursorUsageSummary()`. No new fetching: the bar subscribes to that store and asks it to `load()`,
 * which the store itself throttles (it skips reloads within 30 s of the last one).
 */
import type { ComponentFactory, PluginContext } from "@better-grok-bot/sdk";

/** The usage summary fields the bar reads (the app's summary has more). */
export interface UsageSummary {
	sandUsagePercent?: number | null;
	sandUsageResetTimestampMs?: number | null;
	enterpriseTeamId?: string | null;
}

/** A snapshot of the app's usage-summary store. */
export interface UsageSnapshot {
	status?: string;
	value?: UsageSummary | null;
	previous?: UsageSummary | null;
}

interface UsageStore {
	snapshots: { get(): UsageSnapshot; subscribe(listener: () => void): () => void };
	load?: () => void;
}

export type BarView =
	| { kind: "hidden" }
	| { kind: "loading" }
	| { kind: "meter"; percent: number; label: string; level: "normal" | "high" | "full"; resetLabel: string | null };

const DAY_MS = 24 * 60 * 60 * 1000;
/** How often the mounted bar asks the store to revalidate (the store throttles on its own too). */
const RELOAD_MS = 5 * 60 * 1000;

/** The store's current summary, as Settings → Usage picks it: `value` when ready, else the last good one. */
export function currentSummary(snapshot: UsageSnapshot | undefined): UsageSummary | null {
	if (snapshot === undefined) return null;
	if (snapshot.status === "ready") return snapshot.value ?? null;
	if (snapshot.status === "loading" || snapshot.status === "failed") return snapshot.previous ?? null;
	return null;
}

/** Formats like the app's usage meter: clamped to 0–100, anything in (0, 1) shows as 1%. */
export function formatPercent(percent: number): string {
	const clamped = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0;
	const shown = clamped > 0 && clamped < 1 ? 1 : Math.round(clamped);
	return new Intl.NumberFormat(undefined, { style: "percent" }).format(shown / 100);
}

export function resetLabel(resetMs: number | null | undefined, nowMs: number): string | null {
	if (resetMs == null || !Number.isFinite(resetMs)) return null;
	const remaining = resetMs - nowMs;
	if (remaining <= 0) return "Resets soon";
	const days = Math.ceil(remaining / DAY_MS);
	return days === 1 ? "Resets in 1 day" : `Resets in ${days} days`;
}

export function barView(snapshot: UsageSnapshot | undefined, nowMs: number): BarView {
	const summary = currentSummary(snapshot);
	if (summary === null) {
		const status = snapshot?.status;
		return status === "loading" || status === "idle" ? { kind: "loading" } : { kind: "hidden" };
	}
	// Enterprise seats and plans without an included weekly pool have no percentage; Settings shows no weekly meter either.
	const raw = summary.sandUsagePercent;
	if (summary.enterpriseTeamId != null || raw == null || !Number.isFinite(raw)) return { kind: "hidden" };
	const percent = Math.min(Math.max(raw, 0), 100);
	return {
		kind: "meter",
		percent,
		label: formatPercent(raw),
		level: percent >= 100 ? "full" : percent >= 80 ? "high" : "normal",
		resetLabel: resetLabel(summary.sandUsageResetTimestampMs, nowMs),
	};
}

function usageStore(client: unknown): UsageStore | undefined {
	if (typeof client !== "object" || client === null) return undefined;
	const store = (client as { usageSummary?: unknown }).usageSummary;
	if (typeof store !== "object" || store === null) return undefined;
	const snapshots = (store as { snapshots?: unknown }).snapshots;
	if (typeof snapshots !== "object" || snapshots === null) return undefined;
	const { get, subscribe } = snapshots as { get?: unknown; subscribe?: unknown };
	if (typeof get !== "function" || typeof subscribe !== "function") return undefined;
	return store as UsageStore;
}

const noop = (): void => {};

function createWeeklyUsage(ctx: PluginContext) {
	const subscribeClient = (onChange: () => void): (() => void) => ctx.app.onClient(onChange);
	const readClient = (): unknown => ctx.app.client;

	/** Sidebar footer bar; renders nothing without a weekly percentage. */
	const SidebarBar: ComponentFactory = ({ React, jsx }) =>
		function WeeklyUsageBar() {
			const client = React.useSyncExternalStore(subscribeClient, readClient);
			const store = usageStore(client);
			const subscribe = React.useCallback(
				(onChange: () => void) => (store === undefined ? noop : store.snapshots.subscribe(onChange)),
				[store],
			);
			const snapshot = React.useSyncExternalStore(subscribe, () => store?.snapshots.get());
			React.useEffect(() => {
				if (store?.load === undefined) return;
				const load = (): void => {
					try {
						store.load?.();
					} catch (error) {
						ctx.log.warn("usage summary load failed", error);
					}
				};
				load();
				const timer = setInterval(load, RELOAD_MS);
				return () => clearInterval(timer);
			}, [store]);

			const view = barView(snapshot, Date.now());
			if (view.kind === "hidden") return null;
			const loading = view.kind === "loading";
			const percent = loading ? 0 : view.percent;
			const valueText = loading ? "" : view.label;
			const title = loading ? undefined : (view.resetLabel ?? undefined);
			return jsx("div", {
				className: "bgb-weekly-usage",
				"data-level": loading ? "loading" : view.level,
				title,
				children: [
					jsx(
						"div",
						{
							className: "bgb-weekly-usage__header",
							children: [
								jsx("span", { className: "bgb-weekly-usage__title", children: "Weekly usage" }, "title"),
								jsx("span", { className: "bgb-weekly-usage__value", children: valueText }, "value"),
							],
						},
						"header",
					),
					jsx(
						"div",
						{
							className: "bgb-weekly-usage__track sand-9f619 sand-qu0tyb sand-b3r6kr sand-1i4c3av sand-25lytf",
							role: "meter",
							"aria-label": loading ? "Weekly usage, loading" : `Weekly usage ${view.label}`,
							"aria-valuemin": 0,
							"aria-valuemax": 100,
							"aria-valuenow": loading ? undefined : percent,
							"aria-busy": loading || undefined,
							children: jsx("div", {
								className: "bgb-weekly-usage__fill sand-9f619 sand-5yr21d sand-1i4c3av",
								style: { width: `${percent}%` },
							}),
						},
						"track",
					),
				],
			});
		};

	return { SidebarBar };
}

globalThis.BetterGrokBot?.define("weekly-usage", createWeeklyUsage);

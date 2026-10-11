import { describe, expect, test } from "bun:test";
import { barView, currentSummary, formatPercent, resetLabel } from "./runtime.ts";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("currentSummary", () => {
	test("uses the value when ready and the previous value while loading or failed", () => {
		expect(currentSummary({ status: "ready", value: { sandUsagePercent: 5 } })).toEqual({ sandUsagePercent: 5 });
		expect(currentSummary({ status: "loading", previous: { sandUsagePercent: 6 } })).toEqual({ sandUsagePercent: 6 });
		expect(currentSummary({ status: "failed", previous: null })).toBeNull();
		expect(currentSummary({ status: "empty" })).toBeNull();
		expect(currentSummary(undefined)).toBeNull();
	});
});

describe("formatPercent", () => {
	test("clamps and rounds like the app's meter", () => {
		expect(formatPercent(42.4)).toBe(new Intl.NumberFormat(undefined, { style: "percent" }).format(0.42));
		expect(formatPercent(0.2)).toBe(new Intl.NumberFormat(undefined, { style: "percent" }).format(0.01));
		expect(formatPercent(250)).toBe(new Intl.NumberFormat(undefined, { style: "percent" }).format(1));
		expect(formatPercent(Number.NaN)).toBe(new Intl.NumberFormat(undefined, { style: "percent" }).format(0));
	});
});

describe("resetLabel", () => {
	test("counts whole days up", () => {
		expect(resetLabel(NOW + DAY / 2, NOW)).toBe("Resets in 1 day");
		expect(resetLabel(NOW + 2.5 * DAY, NOW)).toBe("Resets in 3 days");
		expect(resetLabel(NOW - 1, NOW)).toBe("Resets soon");
		expect(resetLabel(null, NOW)).toBeNull();
	});
});

describe("barView", () => {
	test("loading without data shows the placeholder; empty, unavailable and failed hide", () => {
		expect(barView({ status: "loading" }, NOW)).toEqual({ kind: "loading" });
		expect(barView({ status: "idle" }, NOW)).toEqual({ kind: "loading" });
		expect(barView({ status: "failed" }, NOW)).toEqual({ kind: "hidden" });
		expect(barView({ status: "empty" }, NOW)).toEqual({ kind: "hidden" });
		expect(barView({ status: "unavailable" }, NOW)).toEqual({ kind: "hidden" });
		expect(barView(undefined, NOW)).toEqual({ kind: "hidden" });
	});

	test("hides for enterprise seats and plans without a weekly percentage", () => {
		expect(barView({ status: "ready", value: { enterpriseTeamId: "t", sandUsagePercent: 10 } }, NOW)).toEqual({ kind: "hidden" });
		expect(barView({ status: "ready", value: { sandUsagePercent: null } }, NOW)).toEqual({ kind: "hidden" });
	});

	test("maps the percentage to a clamped meter with a level", () => {
		const view = barView({ status: "ready", value: { sandUsagePercent: 85, sandUsageResetTimestampMs: NOW + DAY } }, NOW);
		expect(view).toMatchObject({ kind: "meter", percent: 85, level: "high", resetLabel: "Resets in 1 day" });
		expect(barView({ status: "ready", value: { sandUsagePercent: 30 } }, NOW)).toMatchObject({ level: "normal", percent: 30 });
		expect(barView({ status: "ready", value: { sandUsagePercent: 140 } }, NOW)).toMatchObject({ level: "full", percent: 100 });
		expect(barView({ status: "failed", previous: { sandUsagePercent: 12 } }, NOW)).toMatchObject({ kind: "meter", percent: 12 });
	});
});

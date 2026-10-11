/** Turns canary job results (`bgb check --json`, `e2e-*.json`) into recorded failures. */

export type EntryStatus = "pass" | "fail" | "error";

export interface Failure {
	check: string;
	pluginId?: string;
	patchId?: string;
	matches?: number;
	expected?: number;
	message?: string;
}

export const NO_RESULT = "no result (the job crashed or was cancelled)";

/** Failures of one `bgb check --json` report; `null` when the report is missing or unreadable. */
export function compatFailures(report: unknown): Failure[] | null {
	if (!report || typeof report !== "object" || !("ok" in report) || typeof report.ok !== "boolean") return null;
	const failures: Failure[] = [];
	if ("supported" in report && report.supported === false) {
		failures.push({ check: "compat", message: "error" in report && typeof report.error === "string" ? report.error : "Grok Bot is not supported" });
	}
	const plugins: unknown[] = "plugins" in report && Array.isArray(report.plugins) ? report.plugins : [];
	for (const plugin of plugins) {
		if (!plugin || typeof plugin !== "object") continue;
		const id = "id" in plugin && typeof plugin.id === "string" ? plugin.id : "?";
		const source = "source" in plugin ? plugin.source : undefined;
		const state = "state" in plugin ? plugin.state : undefined;
		// Only core hooks and bundled plugins gate a Grok Bot release.
		if ((source !== "core" && source !== "bundled") || state === "active") continue;
		const patches: unknown[] = "patches" in plugin && Array.isArray(plugin.patches) ? plugin.patches : [];
		let listed = false;
		for (const patch of patches) {
			if (!patch || typeof patch !== "object" || !("ok" in patch) || patch.ok !== false) continue;
			listed = true;
			failures.push({
				check: "compat",
				pluginId: id,
				patchId: "id" in patch && typeof patch.id === "string" ? patch.id : undefined,
				matches: "matches" in patch && typeof patch.matches === "number" ? patch.matches : undefined,
				expected: "expected" in patch && typeof patch.expected === "number" ? patch.expected : undefined,
			});
		}
		if (!listed) {
			const errors: unknown[] = "errors" in plugin && Array.isArray(plugin.errors) ? plugin.errors : [];
			const first = errors[0];
			failures.push({ check: "compat", pluginId: id, message: typeof first === "string" ? first : `state ${String(state)}` });
		}
	}
	if (!report.ok && failures.length === 0) failures.push({ check: "compat", message: "check reported ok: false" });
	return failures;
}

/** Failures of one `e2e-<feedPlatform>.json`; `null` when missing or unreadable. */
export function e2eFailures(result: unknown): Failure[] | null {
	if (!result || typeof result !== "object" || !("ok" in result) || typeof result.ok !== "boolean") return null;
	const messages: unknown[] = "failures" in result && Array.isArray(result.failures) ? result.failures : [];
	const failures: Failure[] = messages.map((message) => ({ check: "e2e", message: String(message) }));
	if (!result.ok && failures.length === 0) failures.push({ check: "e2e", message: "e2e reported ok: false" });
	return failures;
}

/**
 * One feed entry's outcome. `undefined`/unparseable results count as missing. `pass` = every
 * expected result exists and is clean; `fail` = some result lists failures; `error` = only missing results.
 */
export function classifyEntry(compat: unknown, e2e: { expected: boolean; result: unknown }): { status: EntryStatus; failures: Failure[] } {
	const failures: Failure[] = [];
	let listed = false;
	const compatList = compatFailures(compat);
	if (compatList === null) {
		failures.push({ check: "compat", message: NO_RESULT });
	} else {
		listed ||= compatList.length > 0;
		failures.push(...compatList);
	}
	if (e2e.expected) {
		const e2eList = e2eFailures(e2e.result);
		if (e2eList === null) {
			failures.push({ check: "e2e", message: NO_RESULT });
		} else {
			listed ||= e2eList.length > 0;
			failures.push(...e2eList);
		}
	}
	return { status: failures.length === 0 ? "pass" : listed ? "fail" : "error", failures };
}

/** Markdown table of the failing checks (ids and counts only; never app code). */
export function failureTable(rows: { key: string; status: EntryStatus; failures: Failure[] }[]): string {
	const cell = (value: string | number | undefined): string => (value === undefined ? "" : String(value).replaceAll("|", "\\|").replaceAll("\n", " "));
	const lines = ["| Entry | Status | Check | Plugin | Patch | Matches | Expected | Message |", "|---|---|---|---|---|---|---|---|"];
	for (const row of rows) {
		for (const failure of row.failures) {
			lines.push(
				`| \`${row.key}\` | ${row.status} | ${cell(failure.check)} | ${cell(failure.pluginId)} | ${cell(failure.patchId)} | ${cell(failure.matches)} | ${cell(failure.expected)} | ${cell(failure.message)} |`,
			);
		}
	}
	return lines.join("\n");
}

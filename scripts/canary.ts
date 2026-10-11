#!/usr/bin/env bun
/**
 * Upstream canary: tests every new Grok Bot release on the public feed.
 *
 *   bun scripts/canary.ts detect [--force]
 *   bun scripts/canary.ts report --results <dir>
 *
 * State lives in `upstream.json` on the unprotected branch `canary-state`:
 * `{entries: {"<feedPlatform>@<version>+<commitSha>": {status, bgbCommit, checkedAt, failures, reportedHash}}}`.
 *
 * `detect` selects feed entries that are new, or not passing and not yet tested with the current
 * commit (or all with `--force`), and writes the `compat` and `e2e` job matrices (with pinned
 * download URLs) plus the selection to `$GITHUB_OUTPUT` and `<cwd>/canary-selected.json`.
 *
 * `report` reads `canary-selected.json`, `compat-<feedPlatform>.json` and `e2e-<feedPlatform>.json`
 * from `--results`, records each entry as `pass`/`fail`/`error`, commits `upstream.json` to
 * `canary-state`, and opens, comments on or closes the `upstream-break` issue of each version. Issue
 * status counts only the entries the feed published at `detect`; entries of superseded commits stay in
 * the state for the record.
 */
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { classifyEntry, type EntryStatus, type Failure, failureTable } from "./canary-results.ts";
import { FEED_PLATFORMS, type FeedPlatform, type Format, readFeed } from "./feed.ts";
import { REPO_ROOT, run, runMain, ScriptError, sha256Hex } from "./lib.ts";

const STATE_BRANCH = "canary-state";
const STATE_FILE = "upstream.json";
const SELECTED_FILE = "canary-selected.json";
const ISSUE_LABEL = "upstream-break";

export interface StateEntry {
	status: EntryStatus;
	bgbCommit: string;
	checkedAt: string;
	failures: Failure[];
	reportedHash: string | null;
}

interface CanaryState {
	entries: Record<string, StateEntry>;
}

interface CompatJob {
	key: string;
	feedPlatform: FeedPlatform;
	version: string;
	commitSha: string;
	url: string;
	format: Format;
	runner: string;
}

interface E2eJob extends CompatJob {
	/** Release asset name the job builds with `build-binaries.ts archive`. */
	asset: string;
}

interface Selection {
	bgbCommit: string;
	/** Keys of every feed entry published at `detect`, tested or not. */
	current: string[];
	compat: CompatJob[];
	e2e: E2eJob[];
}

/** Feed platforms that also get a full e2e run, with their runner and archive name. */
const E2E_TARGETS: Partial<Record<FeedPlatform, { runner: string; asset: string }>> = {
	"darwin-arm64": { runner: "macos-15", asset: "bgb-darwin-arm64" },
	"win32-x64-user": { runner: "windows-2025", asset: "bgb-windows-x64" },
	"linux-x64": { runner: "ubuntu-24.04", asset: "bgb-linux-x64" },
};

function emptyState(): CanaryState {
	return { entries: {} };
}

function parseState(text: string): CanaryState {
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || !("entries" in parsed) || !parsed.entries || typeof parsed.entries !== "object") {
		throw new ScriptError(`${STATE_FILE} on ${STATE_BRANCH} is malformed`);
	}
	// Written only by this script; the top-level shape is checked above.
	const state = parsed as CanaryState;
	return state;
}

/** Fetches `canary-state`; returns its head commit and `upstream.json`, or `null` when the branch is missing. */
async function fetchState(): Promise<{ head: string; state: CanaryState } | null> {
	const fetched = await run(["git", "fetch", "--no-tags", "--depth=1", "origin", `refs/heads/${STATE_BRANCH}`], { cwd: REPO_ROOT, allowFail: true });
	if (fetched.exitCode !== 0) {
		if (/couldn't find remote ref/i.test(fetched.stderr)) return null;
		throw new ScriptError(`git fetch ${STATE_BRANCH} failed:\n${fetched.stderr.trim()}`);
	}
	const head = (await run(["git", "rev-parse", "FETCH_HEAD"], { cwd: REPO_ROOT })).stdout.trim();
	const shown = await run(["git", "show", `${head}:${STATE_FILE}`], { cwd: REPO_ROOT, allowFail: true });
	return { head, state: shown.exitCode === 0 ? parseState(shown.stdout) : emptyState() };
}

async function writeOutputs(outputs: Record<string, string>): Promise<void> {
	const file = process.env.GITHUB_OUTPUT;
	if (!file) return;
	await appendFile(file, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
}

async function summary(markdown: string): Promise<void> {
	if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

async function detect(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: { force: { type: "boolean" } }, strict: true });
	const force = values.force === true;
	const bgbCommit = (await run(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT })).stdout.trim();
	const state = (await fetchState())?.state ?? emptyState();
	const selection: Selection = { bgbCommit, current: [], compat: [], e2e: [] };

	for (const feedPlatform of FEED_PLATFORMS) {
		const entry = await readFeed(feedPlatform);
		const key = `${feedPlatform}@${entry.version}+${entry.commitSha}`;
		selection.current.push(key);
		const previous = state.entries[key];
		const selected = force || !previous || (previous.status !== "pass" && previous.bgbCommit !== bgbCommit);
		console.error(`[detect] ${key}: ${previous ? `${previous.status} at ${previous.bgbCommit.slice(0, 7)}` : "new"} → ${selected ? "test" : "skip"}`);
		if (!selected) continue;
		const os = feedPlatform.split("-")[0];
		let job: CompatJob;
		if (os === "darwin") {
			job = { key, feedPlatform, version: entry.version, commitSha: entry.commitSha, url: entry.downloadUrl, format: "dmg", runner: "macos-15" };
		} else if (os === "win32") {
			job = { key, feedPlatform, version: entry.version, commitSha: entry.commitSha, url: entry.downloadUrl, format: "exe", runner: "ubuntu-24.04" };
		} else {
			if (!entry.debUrl) throw new ScriptError(`the feed has no debUrl for ${feedPlatform}`);
			job = { key, feedPlatform, version: entry.version, commitSha: entry.commitSha, url: entry.debUrl, format: "deb", runner: "ubuntu-24.04" };
		}
		selection.compat.push(job);
		const e2e = E2E_TARGETS[feedPlatform];
		if (e2e) selection.e2e.push({ ...job, runner: e2e.runner, asset: e2e.asset });
	}

	const selectedJson = JSON.stringify(selection, null, "\t");
	await writeFile(path.resolve(SELECTED_FILE), `${selectedJson}\n`);
	await writeOutputs({
		compat: JSON.stringify({ include: selection.compat }),
		e2e: JSON.stringify({ include: selection.e2e }),
		commit: bgbCommit,
		"has-compat": String(selection.compat.length > 0),
		"has-e2e": String(selection.e2e.length > 0),
	});
	await summary(
		selection.compat.length === 0
			? "No new Grok Bot releases to test."
			: `Testing ${selection.compat.map((job) => `\`${job.key}\``).join(", ")} (e2e: ${selection.e2e.map((job) => job.feedPlatform).join(", ") || "none"}).`,
	);
	console.log(selectedJson);
}

async function readResult(dir: string, name: string): Promise<unknown> {
	const text = await readFile(path.join(dir, name), "utf8").catch(() => null);
	if (text === null) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

/**
 * Keys among `current` (the published feed entries) of upstream `version` whose recorded status is not
 * `pass`. Entries of commits the feed no longer publishes are ignored, so a superseded failure cannot
 * keep a version's issue open.
 */
export function brokenKeys(entries: Readonly<Record<string, StateEntry>>, current: readonly string[], version: string): string[] {
	return current.filter((key) => {
		const entry = entries[key];
		return key.split("@")[1]?.startsWith(`${version}+`) === true && entry !== undefined && entry.status !== "pass";
	});
}

async function gh(args: string[]): Promise<string> {
	return (await run(["gh", ...args], { cwd: REPO_ROOT })).stdout;
}

async function findIssue(title: string): Promise<number | null> {
	const listed: unknown = JSON.parse(await gh(["issue", "list", "--state", "open", "--label", ISSUE_LABEL, "--limit", "100", "--json", "number,title"]));
	if (!Array.isArray(listed)) return null;
	for (const issue of listed as unknown[]) {
		if (issue && typeof issue === "object" && "title" in issue && issue.title === title && "number" in issue && typeof issue.number === "number") {
			return issue.number;
		}
	}
	return null;
}

/** Commits `state` as `upstream.json` on `canary-state` on top of `parent` (orphan when null). */
async function commitState(state: CanaryState, parent: string | null, message: string): Promise<string> {
	const work = await mkdtemp(path.join(tmpdir(), "bgb-canary-"));
	try {
		const file = path.join(work, STATE_FILE);
		await writeFile(file, `${JSON.stringify(state, null, "\t")}\n`);
		const blob = (await run(["git", "hash-object", "-w", file], { cwd: REPO_ROOT })).stdout.trim();
		const tree = (
			await run(["git", "mktree"], { cwd: REPO_ROOT, stdin: new TextEncoder().encode(`100644 blob ${blob}\t${STATE_FILE}\n`) })
		).stdout.trim();
		const identity = {
			GIT_AUTHOR_NAME: "github-actions[bot]",
			GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
			GIT_COMMITTER_NAME: "github-actions[bot]",
			GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
		};
		const commitArgs = ["git", "commit-tree", tree, "-m", message, ...(parent ? ["-p", parent] : [])];
		return (await run(commitArgs, { cwd: REPO_ROOT, env: identity })).stdout.trim();
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function report(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: { results: { type: "string" } }, strict: true });
	if (!values.results) throw new ScriptError("usage: bun scripts/canary.ts report --results <dir>", 2);
	const results = path.resolve(values.results);
	const selectionRaw = await readResult(results, SELECTED_FILE);
	if (selectionRaw === undefined || selectionRaw === null) throw new ScriptError(`${SELECTED_FILE} is missing from ${results}; detect did not finish`);
	// Written by `detect` in this workflow run.
	const selection = selectionRaw as Selection;
	if (selection.compat.length === 0) {
		console.log("nothing was selected");
		return;
	}
	const e2eKeys = new Set(selection.e2e.map((job) => job.key));
	const checkedAt = new Date().toISOString();
	const outcomes: { job: CompatJob; status: EntryStatus; failures: Failure[] }[] = [];
	for (const job of selection.compat) {
		const { status, failures } = classifyEntry(await readResult(results, `compat-${job.feedPlatform}.json`), {
			expected: e2eKeys.has(job.key),
			result: await readResult(results, `e2e-${job.feedPlatform}.json`),
		});
		outcomes.push({ job, status, failures });
		console.error(`[report] ${job.key}: ${status}${failures.length ? ` (${failures.length} failures)` : ""}`);
	}

	let fetched = await fetchState();
	const base = fetched?.state ?? emptyState();
	const updates: Record<string, StateEntry> = {};
	for (const outcome of outcomes) {
		updates[outcome.job.key] = {
			status: outcome.status,
			bgbCommit: selection.bgbCommit,
			checkedAt,
			failures: outcome.failures,
			reportedHash: base.entries[outcome.job.key]?.reportedHash ?? null,
		};
	}

	// Issues per upstream version.
	const runUrl =
		process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
			? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
			: "(local run)";
	const versions = [...new Set(outcomes.map((outcome) => outcome.job.version))];
	if (versions.length > 0) {
		await gh(["label", "create", ISSUE_LABEL, "--force", "--color", "d73a4a", "--description", "A Grok Bot release breaks Better Grok Bot"]);
	}
	const summaryLines: string[] = [];
	for (const version of versions) {
		const title = `Grok Bot ${version} breaks Better Grok Bot`;
		const merged = { ...base.entries, ...updates };
		const broken = brokenKeys(merged, selection.current, version);
		const issue = await findIssue(title);
		if (broken.length === 0) {
			summaryLines.push(`- ${version}: pass`);
			if (issue !== null) {
				await gh(["issue", "close", String(issue), "--comment", `Every platform of Grok Bot ${version} passes as of ${runUrl}.`]);
				console.error(`[report] closed #${issue}`);
			}
			continue;
		}
		const table = failureTable(broken.map((key) => ({ key, status: merged[key]?.status ?? "error", failures: merged[key]?.failures ?? [] })));
		const hash = sha256Hex(table);
		summaryLines.push(`- ${version}: ${broken.length} broken entr${broken.length === 1 ? "y" : "ies"}`);
		const reported = broken.every((key) => merged[key]?.reportedHash === hash);
		if (reported && issue !== null) continue;
		const body = `The canary found Grok Bot ${version} incompatible with Better Grok Bot \`${selection.bgbCommit.slice(0, 7)}\`.\n\n${table}\n\nRun: ${runUrl}`;
		if (issue === null) {
			const created = await gh(["issue", "create", "--title", title, "--label", ISSUE_LABEL, "--body", body]);
			console.error(`[report] opened ${created.trim()}`);
		} else {
			await gh(["issue", "comment", String(issue), "--body", body]);
			console.error(`[report] commented on #${issue}`);
		}
		for (const key of broken) {
			const update = updates[key];
			if (update) update.reportedHash = hash;
			else {
				const existing = base.entries[key];
				if (existing) updates[key] = { ...existing, reportedHash: hash };
			}
		}
	}

	const counts = outcomes.reduce<Record<EntryStatus, number>>(
		(acc, outcome) => {
			acc[outcome.status]++;
			return acc;
		},
		{ pass: 0, fail: 0, error: 0 },
	);
	const message = `chore(canary): ${counts.pass} pass, ${counts.fail} fail, ${counts.error} error (${versions.join(", ")})`;
	for (let attempt = 1; ; attempt++) {
		const state: CanaryState = { entries: { ...(fetched?.state.entries ?? {}), ...updates } };
		const commit = await commitState(state, fetched?.head ?? null, message);
		const pushed = await run(["git", "push", "origin", `${commit}:refs/heads/${STATE_BRANCH}`], { cwd: REPO_ROOT, allowFail: true });
		if (pushed.exitCode === 0) {
			console.error(`[report] ${message}`);
			break;
		}
		if (attempt > 3) throw new ScriptError(`could not push ${STATE_BRANCH}:\n${pushed.stderr.trim()}`);
		console.error(`[report] push rejected; refetching ${STATE_BRANCH} (retry ${attempt}/3)`);
		await Bun.sleep(2_000 * attempt);
		fetched = await fetchState();
	}
	await summary(`### Canary\n\n${summaryLines.join("\n")}`);
}

if (import.meta.main) {
	await runMain("canary", async () => {
		const [command, ...rest] = process.argv.slice(2);
		switch (command) {
			case "detect":
				await detect(rest);
				return;
			case "report":
				await report(rest);
				return;
			default:
				throw new ScriptError("usage: bun scripts/canary.ts detect [--force] | report --results <dir>", 2);
		}
	});
}

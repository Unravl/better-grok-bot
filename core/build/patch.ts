import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Patch, PatchResult, PluginPackageJson } from "../../sdk/index.ts";
import { isRecord } from "../plugins/validate.ts";
import {
	type IsolatedRequest,
	type IsolatedResponse,
	LIMITS_ERROR,
	PATCH_LIMITS,
	PATCH_TIMEOUT_MS,
	type PatchAttempt,
	type PatchLimits,
	applyPatches,
	isProtectedRendererPath,
	withinGrowthLimit,
} from "./patch-engine.ts";

export interface IsolatedOptions {
	/** Patch worker entrypoint (`ctx.patchWorkerUrl`). */
	workerUrl: URL;
	timeoutMs?: number;
	limits?: PatchLimits;
}

function failedResults(plugin: PluginPackageJson): PatchResult[] {
	return plugin.patches.map((patch) => ({ id: patch.id, files: [], matches: 0, expected: patch.expect, ok: false }));
}

function isIsolatedResponse(value: unknown): value is IsolatedResponse {
	return (
		isRecord(value) &&
		Array.isArray(value.results) &&
		Array.isArray(value.errors) &&
		value.errors.every((error) => typeof error === "string") &&
		isRecord(value.edits) &&
		Object.values(value.edits).every((text) => typeof text === "string")
	);
}

type WorkerOutcome = IsolatedResponse | { failure: string };

/** Posts one request to a fresh worker; resolves with its reply, or a failure after `timeoutMs`. */
function runWorker(workerUrl: URL, request: IsolatedRequest, timeoutMs: number): Promise<WorkerOutcome> {
	const { promise, resolve } = Promise.withResolvers<WorkerOutcome>();
	const worker = new Worker(workerUrl);
	let settled = false;
	const finish = (outcome: WorkerOutcome): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		worker.terminate();
		resolve(outcome);
	};
	const timer = setTimeout(() => finish({ failure: `patches timed out after ${timeoutMs / 1000} s` }), timeoutMs);
	worker.addEventListener("message", (event: MessageEvent<unknown>) => {
		finish(isIsolatedResponse(event.data) ? event.data : { failure: "patch worker sent a malformed reply" });
	});
	worker.addEventListener("error", (event: ErrorEvent) => finish({ failure: `patch worker failed: ${event.message}` }));
	worker.addEventListener("close", () => finish({ failure: "patch worker exited without a reply" }));
	worker.postMessage(request);
	return promise;
}

/**
 * The extracted renderer plus the edits committed so far. Plugins patch it one at a time; each plugin's
 * patches form one transaction (`attempt`/`attemptIsolated`, then `commit` or drop).
 */
export class PatchWorkspace {
	readonly #texts = new Map<string, string>();
	readonly #dirty = new Set<string>();

	constructor(
		readonly root: string,
		readonly files: readonly string[],
	) {}

	#path(file: string): string {
		return path.join(this.root, ...file.split("/"));
	}

	async #read(file: string): Promise<string> {
		let text = this.#texts.get(file);
		if (text === undefined) {
			text = await Bun.file(this.#path(file)).text();
			this.#texts.set(file, text);
		}
		return text;
	}

	/** Core hooks and bundled plugins: applies `patches` in-process on top of the committed state without committing. */
	async attempt(patches: readonly Patch[]): Promise<PatchAttempt> {
		return applyPatches(
			patches.map((patch) => ({ ...patch, expect: patch.expect ?? 1 })),
			this.files,
			(file) => this.#read(file),
		);
	}

	/**
	 * Community and dev plugins: flushes committed edits to disk, then applies the plugin's string patches in
	 * a fresh worker under one time budget and {@link PATCH_LIMITS}. The returned edits are re-checked here.
	 */
	async attemptIsolated(plugin: PluginPackageJson, opts: IsolatedOptions): Promise<PatchAttempt> {
		if (plugin.patches.length === 0) return { results: [], errors: [], edits: new Map() };
		await this.flush();
		const limits = opts.limits ?? PATCH_LIMITS;
		const outcome = await runWorker(
			opts.workerUrl,
			{ root: this.root, names: [...this.files], patches: plugin.patches, limits },
			opts.timeoutMs ?? PATCH_TIMEOUT_MS,
		);
		if ("failure" in outcome) return { results: failedResults(plugin), errors: [outcome.failure], edits: new Map() };
		if (outcome.errors.length > 0) return { results: outcome.results, errors: outcome.errors, edits: new Map() };

		const edits = new Map(Object.entries(outcome.edits));
		let total = 0;
		for (const [file, text] of edits) {
			if (!this.files.includes(file) || isProtectedRendererPath(file)) {
				return { results: outcome.results, errors: [`patch worker edited a file it may not edit: ${file}`], edits: new Map() };
			}
			total += text.length;
			if (!withinGrowthLimit((await this.#read(file)).length, text.length, limits) || total > limits.totalEditLength) {
				return { results: outcome.results, errors: [LIMITS_ERROR], edits: new Map() };
			}
		}
		return { results: outcome.results, errors: [], edits };
	}

	commit(edits: ReadonlyMap<string, string>): void {
		for (const [file, text] of edits) {
			this.#texts.set(file, text);
			this.#dirty.add(file);
		}
	}

	/** Writes every committed edit not yet on disk. */
	async flush(): Promise<void> {
		for (const file of this.#dirty) await writeFile(this.#path(file), this.#texts.get(file) ?? "");
		this.#dirty.clear();
	}
}

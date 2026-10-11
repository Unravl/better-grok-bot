/**
 * Patch worker: applies one community/dev plugin's string patches off the main thread, so a hostile or
 * catastrophic regex can be terminated. Compiled into the binary as a second entrypoint and reached
 * through `ctx.patchWorkerUrl`.
 */
import { type IsolatedRequest, type IsolatedResponse, runIsolatedRequest } from "./build/patch-engine.ts";
import { errorMessage } from "./errors.ts";

declare const self: Worker;

self.addEventListener("message", async (event: MessageEvent<IsolatedRequest>) => {
	let response: IsolatedResponse;
	try {
		response = await runIsolatedRequest(event.data);
	} catch (error) {
		response = { results: [], errors: [errorMessage(error)], edits: {} };
	}
	self.postMessage(response);
});

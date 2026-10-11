import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readConfig } from "./config.ts";
import { PATCH_WORKER_URL, createContext } from "./context.ts";
import { nullLogger } from "./log.ts";

test("createContext ensures DATA and config and loads this OS's adapter", async () => {
	const parent = await mkdtemp(path.join(tmpdir(), "bgb-ctx-"));
	try {
		const ctx = await createContext({ dataDir: path.join(parent, "data"), log: nullLogger });
		expect(ctx.paths.root).toBe(path.join(parent, "data"));
		expect(existsSync(ctx.paths.locks)).toBe(true);
		expect((await readConfig(ctx.paths)).configVersion).toBe(1);
		expect(ctx.platform.id).toBe(process.platform as "darwin" | "win32" | "linux");
		expect(ctx.patchWorkerUrl).toBe(PATCH_WORKER_URL);
		expect(PATCH_WORKER_URL.pathname.endsWith("/core/patch-worker.ts")).toBe(true);
		expect(Object.isFrozen(ctx)).toBe(true);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

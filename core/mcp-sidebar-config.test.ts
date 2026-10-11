import { expect, test } from "bun:test";
import * as path from "node:path";
import { fakePlatform, tempContext } from "./agent/testing.ts";
import { mutateMcpConfig, readMcpConfig } from "./mcp-config.ts";
import { isManagedSidebarMcpConfig, registerSidebarMcpConfig, sidebarMcpConfig } from "./mcp-sidebar-config.ts";

test("sidebar preset registers disabled, preserves enabled choice and unrelated servers", async () => {
	const ctx = await tempContext(fakePlatform("linux"));
	try {
		await Bun.write(path.join(ctx.paths.bin, ctx.platform.binName()), "test-owned binary");
		const unrelated = { id: "remote", name: "Remote", enabled: true, transport: "http" as const, url: "https://example.test/mcp", headers: {} };
		await mutateMcpConfig(ctx.paths, (servers) => servers.push(unrelated));
		await registerSidebarMcpConfig(ctx);
		const canonical = sidebarMcpConfig(ctx);
		expect(canonical.enabled).toBe(false);
		expect(canonical).toMatchObject({ command: path.join(ctx.paths.bin, ctx.platform.binName()), args: ["--data-dir", ctx.paths.root, "mcp", "sidebar-folders"], env: {} });
		expect(await readMcpConfig(ctx.paths)).toEqual([unrelated, canonical]);
		await mutateMcpConfig(ctx.paths, (servers) => { const preset = servers.find((server) => server.id === canonical.id); if (preset) preset.enabled = true; });
		await registerSidebarMcpConfig(ctx);
		expect(await readMcpConfig(ctx.paths)).toEqual([unrelated, { ...canonical, enabled: true }]);
		expect(isManagedSidebarMcpConfig(ctx, { ...canonical, enabled: true })).toBe(true);
		if (canonical.transport !== "stdio") throw new Error("Expected stdio preset");
		for (const changed of [
			{ ...canonical, command: "bun" },
			{ ...canonical, args: [...canonical.args, "extra"] },
			{ ...canonical, env: { BGB_DATA_DIR: "/another-account" } },
			{ ...canonical, cwd: ctx.paths.root },
			{ ...canonical, id: "another-server" },
		]) expect(isManagedSidebarMcpConfig(ctx, changed)).toBe(false);
	} finally {
		await ctx.cleanup();
	}
});

test("sidebar registration never overwrites a user-owned ID collision", async () => {
	const ctx = await tempContext(fakePlatform("linux"));
	try {
		await Bun.write(path.join(ctx.paths.bin, ctx.platform.binName()), "test-owned binary");
		const canonical = sidebarMcpConfig(ctx);
		const collision = { id: canonical.id, name: "My tools", enabled: true, transport: "http" as const, url: "https://example.test/mcp", headers: {} };
		await mutateMcpConfig(ctx.paths, (servers) => servers.push(collision));
		await registerSidebarMcpConfig(ctx);
		expect(await readMcpConfig(ctx.paths)).toEqual([collision]);
		expect(isManagedSidebarMcpConfig(ctx, collision)).toBe(false);
	} finally {
		await ctx.cleanup();
	}
});

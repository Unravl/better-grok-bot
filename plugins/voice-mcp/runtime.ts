import type { PluginContext } from "@better-grok-bot/sdk";
import { createVoiceAdapter } from "./adapter.ts";
import { createSettings } from "./settings.ts";

export function createVoiceMcp(ctx: PluginContext) {
	const adapter = createVoiceAdapter(ctx.services.mcp, (error) => {
		ctx.log.warn("MCP tools unavailable for this voice session; native voice tools remain available.", error);
	});
	return { ...adapter, SettingsRow: createSettings };
}

globalThis.BetterGrokBot?.define("voice-mcp", createVoiceMcp);

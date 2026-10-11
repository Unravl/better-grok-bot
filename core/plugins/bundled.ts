import botInstructions from "../../plugins/bot-instructions/plugin.ts";
import chatSearch from "../../plugins/chat-search/plugin.ts";
import outputDevice from "../../plugins/output-device/plugin.ts";
import pushToTalk from "../../plugins/push-to-talk/plugin.ts";
import sidebarFolders from "../../plugins/sidebar-folders/plugin.ts";
import startup from "../../plugins/startup/plugin.ts";
import voiceDock from "../../plugins/voice-dock/plugin.ts";
import voiceKeepalive from "../../plugins/voice-keepalive/plugin.ts";
import voiceMcp from "../../plugins/voice-mcp/plugin.ts";
import weeklyUsage from "../../plugins/weekly-usage/plugin.ts";
import { BUNDLED_RUNTIMES, BUNDLED_STYLES } from "../generated/embedded.ts";
import type { BundledPlugin } from "./types.ts";

/** The plugins shipped inside `bgb`, ordered by id; runtimes and styles are bundled by `core/scripts/embed.ts`. */
export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [botInstructions, chatSearch, outputDevice, pushToTalk, sidebarFolders, startup, voiceDock, voiceKeepalive, voiceMcp, weeklyUsage]
	.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
	.map((definition) => ({
		definition,
		runtimeJs: BUNDLED_RUNTIMES[definition.id],
		stylesCss: BUNDLED_STYLES[definition.id],
	}));

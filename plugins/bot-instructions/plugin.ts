import { definePlugin } from "@better-grok-bot/sdk";

const ENTRY_CHUNK = /^assets\/index-[\w-]+\.js$/;

/**
 * Brings back a per-bot instructions field for your own bots.
 *
 * Every bot still has a `description` (the `GrokBotAgent.description` / `UpdateGrokBotAgentRequest.description`
 * field, saved through `client.roster.updateAgent`), which bot templates present as the bot's "Instructions". The
 * app still ships an editor for it ("About", in the info pane's Overview tab), but only shows it for team bots in
 * the simplified pane. This plugin renders an "Instructions" editor in that same spot when the app's editor is hidden.
 */
export default definePlugin({
	id: "bot-instructions",
	name: "Bot Instructions",
	description: "Edit a bot's instructions (its description) in the info pane's Overview tab, for your own bots.",
	version: "0.1.0",
	apiVersion: 1,
	runtime: "runtime.ts",
	styles: "styles.css",
	patches: [
		{
			// Info pane, Overview tab: the app's description editor, shown only for team bots. Where it is hidden,
			// render the plugin's editor instead.
			id: "overview-instructions",
			file: ENTRY_CHUNK,
			find: /(\i)\?(\i)\.jsx\((\i),\{agent:(\i),onDescriptionChange:(\i)\}\):null,(\i\?\i\.teamOverview:null)/,
			replace:
				'$1?$2.jsx($3,{agent:$4,onDescriptionChange:$5}):globalThis.BetterGrokBot?$2.jsx(globalThis.BetterGrokBot.component("bot-instructions","Editor",{jsx:$2.jsx}),{agent:$4}):null,$6',
		},
	],
});

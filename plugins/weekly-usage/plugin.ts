import { definePlugin } from "@better-grok-bot/sdk";

const ENTRY_CHUNK = /^assets\/index-[\w-]+\.js$/;

export default definePlugin({
	id: "weekly-usage",
	name: "Weekly Usage",
	description:
		"Shows your weekly usage as a progress bar above Connect Apps in the sidebar, from the same usage summary as Settings → Usage.",
	version: "0.1.0",
	apiVersion: 1,
	runtime: "runtime.ts",
	styles: "styles.css",
	patches: [
		{
			// Sidebar footer (expanded): the account row holding the avatar and the Connect Apps pill. The bar is
			// rendered as its preceding sibling in the same children array, so it sits directly above the pill.
			id: "sidebar-usage-bar",
			file: ENTRY_CHUNK,
			find: /(\i)\.jsxs\("div",\{"data-action-engaged":\i\|\|void 0,"data-sidebar-account":!0,/,
			replace:
				'globalThis.BetterGrokBot?$1.jsx(globalThis.BetterGrokBot.component("weekly-usage","SidebarBar",{jsx:$1.jsx}),{}):null,$&',
		},
	],
});

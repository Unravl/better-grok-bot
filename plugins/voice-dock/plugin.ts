import { definePlugin, type PatchMatch } from "@better-grok-bot/sdk";

const ENTRY_CHUNK = /^assets\/index-[\w-]+\.js$/;
const ID = "[\\w$]+";

/** The voice-call popover component's name, read from where the chat view renders it. */
function popoverComponent(text: string): string {
	const found = new RegExp(
		`\\.jsx\\((${ID}),\\{agent:${ID},call:${ID},onDismissFailure:${ID}\\.dismissFailure,onHangUp:\\(\\)=>\\{${ID}\\.hangUp\\(\\)\\},onToggleMute:${ID}\\.toggleMute\\}\\)`,
	).exec(text);
	if (found?.[1] === undefined) throw new Error("voice-call popover component not found");
	return found[1];
}

export default definePlugin({
	id: "voice-dock",
	name: "Voice Dock",
	description:
		"Docks the voice-call controls (status, settings, transcript, mute, hang up) in the sidebar footer, so they stay reachable from any bot. With the sidebar collapsed the app's floating panel is used.",
	version: "0.1.0",
	apiVersion: 1,
	runtime: "runtime.ts",
	styles: "styles.css",
	patches: [
		{
			// Sidebar footer (expanded): renders the dock before the account row (avatar + Connect Apps). Plugins
			// patch in id order, so the weekly-usage bar, inserted later at the same spot, lands between the dock
			// and the account row. The dock renders the app's own voice-call popover component.
			id: "sidebar-dock",
			file: ENTRY_CHUNK,
			find: /(\i)\.jsxs\("div",\{"data-action-engaged":\i\|\|void 0,"data-sidebar-account":!0,/,
			replace: (m: PatchMatch) => {
				const jsx = m.groups[0] ?? "";
				const popover = popoverComponent(m.text);
				return `globalThis.BetterGrokBot?${jsx}.jsx(globalThis.BetterGrokBot.component("voice-dock","Dock",{jsx:${jsx}.jsx,Popover:${popover}}),{}):null,${m.match}`;
			},
		},
		{
			// Chat view: the floating popover over the bot in the call. Hidden while the dock is mounted (so the
			// controls are not shown twice); the hook re-renders the view when the dock comes or goes.
			id: "chat-popover",
			file: ENTRY_CHUNK,
			find: /(\i\.shouldShowPopover\(\{call:\i,viewedAgentId:\i\.currentAgentId\}\)[^;]*;const \i=)(\i),/,
			replace: '$1globalThis.BetterGrokBot?.call("voice-dock","useDocked")?!1:$2,',
		},
		{
			// Popover controls: small (24px) instead of large (44px) buttons when docked (`bgbDocked` prop, set only by the dock).
			id: "docked-control-size",
			file: ENTRY_CHUNK,
			find: /\{call:\i,agent:\i,onToggleMute:\i,onHangUp:\i,onDismissFailure:\i\}=(\i)[^]*?"data-voice-call-controls":!0,children:\[[^]*?style:\i\.hangUp\}\)\}\)\]/,
			replace: (m: PatchMatch) => {
				const props = m.groups[0] ?? "";
				const at = m.match.indexOf('"data-voice-call-controls"');
				const tail = m.match.slice(at);
				const sizes = tail.split('size:"lg"').length - 1;
				if (sizes !== 4) throw new Error(`expected 4 large voice controls, found ${sizes}`);
				return m.match.slice(0, at) + tail.replaceAll('size:"lg"', `size:${props}.bgbDocked?"sm":"lg"`);
			},
		},
	],
});

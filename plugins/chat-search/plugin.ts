import { definePlugin, type PatchMatch } from "@better-grok-bot/sdk";

const ENTRY_CHUNK = /^assets\/index-[\w-]+\.js$/;

function sessionHook(match: PatchMatch, owner: string): string {
	const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const found = new RegExp(`([\\w$]+)\\(${escaped}\\.currentAgentId\\?\\?void 0\\)`).exec(match.text);
	if (found?.[1] === undefined) throw new Error("native chat session hook not found");
	return found[1];
}

export default definePlugin({
	id: "chat-search",
	name: "Chat Search",
	description: "Search the current bot conversation, including earlier history, using the app's native finder and highlighted match navigation.",
	version: "0.1.0",
	apiVersion: 1,
	runtime: "runtime.ts",
	styles: "styles.css",
	patches: [
		{
			// Match the root's command object, not the palette's matching props destructuring.
			id: "native-open-command",
			file: ENTRY_CHUNK,
			find: /(\{currentAgent:\i,currentAgentId:\i,isAnysphereUser:\i\.isAnysphereUser,isDevBuild:\i,isChatSurfaceVisible:\i,isCommandPaletteOpen:\i,openCommandPalette:\i,closeCommandPalette:\i,toggleCommandPalette:\i,)openFindInChat:(\i),isTeamAgentsEnabled:/,
			replace: '$1openFindInChat:(globalThis.BetterGrokBot?.call("chat-search","captureOpen",$2)??$2),isTeamAgentsEnabled:',
			expect: 1,
		},
		{
			id: "header-search-button",
			file: ENTRY_CHUNK,
			find: /className:\i\("sand-chat-header__controls",\i\.className\),style:\i\.style,children:\[(?=\i==null\?null:(\i)\.jsx\()/,
			replace: '$&globalThis.BetterGrokBot?$1.jsx(globalThis.BetterGrokBot.component("chat-search","SearchButton",{jsx:$1.jsx}),{}):null,',
			expect: 1,
		},
		{
			// Only the main conversation mount: task-thread finders have a different history contract.
			id: "native-finder-history",
			file: ENTRY_CHUNK,
			find: /(\i)\.jsx\((\i),\{entries:(\i)\.entries,focusNonce:(\i)\.findInChat\.focusNonce,onClose:\4\.findInChat\.close,transcriptHandleRef:(\i)\},\3\.transcriptPlaneKey\)/,
			replace: (match: PatchMatch) => {
				const [jsx, finder, transcript, owner, handle] = match.groups;
				if (!jsx || !finder || !transcript || !owner || !handle) throw new Error("native finder mount is incomplete");
				const useSession = sessionHook(match, owner);
				return `${jsx}.jsx(globalThis.BetterGrokBot?.call("chat-search","selectFinder",{jsx:${jsx}.jsx,NativeFinder:${finder},useSession:${useSession}})??${finder},{entries:${transcript}.entries,focusNonce:${owner}.findInChat.focusNonce,onClose:${owner}.findInChat.close,transcriptHandleRef:${handle},agentId:${owner}.currentAgentId},${transcript}.transcriptPlaneKey)`;
			},
			expect: 1,
		},
	],
});

import { definePlugin } from "@better-grok-bot/sdk";

const ENTRY_CHUNK = /^assets\/index-[\w-]+\.js$/;
const SETTINGS_VIEW_CHUNK = /^assets\/chunk-view-[\w-]+\.js$/;

export default definePlugin({
	id: "startup",
	name: "Startup",
	description:
		"Start a voice chat with a chosen bot when Grok Bot starts (Settings → General → System → Start voice on startup). Opening Grok Bot at login is in the Better Grok Bot section.",
	version: "0.1.0",
	apiVersion: 1,
	runtime: "runtime.ts",
	patches: [
		{
			// Chat view: the composer's voice-call button handler (`onStartVoiceCall`) for the bot on screen,
			// defined only while that bot can be called and no call is up.
			id: "composer-voice-call",
			file: ENTRY_CHUNK,
			find: /((\i)=\i\.currentAgent,\i=\i\("grok_bot_multiplayer"\)[^]*?)(\i)=(\i\.kind==="idle"&&\i!==null\?\i:void 0),/,
			replace: '$1$3=globalThis.BetterGrokBot?.call("startup","offerVoiceCall",$2?.id??null,$4)??($4),',
		},
		{
			// Settings → General → System: the startup rows right after the section's first row (Microphone,
			// plus the rows other plugins render inside it). Select comes from the Microphone row, Toggle and Row
			// from the Hardware Acceleration row, React from the Network Debugger row; the section is the one
			// gated on "grok_bot_network_debugger".
			id: "settings-rows",
			file: SETTINGS_VIEW_CHUNK,
			find: /(anchorId:"microphone",variant:"card",children:\i\.jsx\((\i),\{"aria-label":\i,onValueChange:\i,options:\i,placement:"bottom-end",size:"lg",value:\i,variant:"ghost"\}\)[^]*?\.jsx\((\i),\{isChecked:\i,isDisabled:\i,label:\i,onToggle:\i,size:"md"\}\)(?:(?!isChecked:)[^])*?\.jsx\((\i),\{anchorId:"hardware-acceleration",description:[^]*?=(\i)\.useState\(!1\)[^]*?\("grok_bot_network_debugger"\)[^]*?(\i)\.jsxs\(\i,\{title:\i,children:\[\i,)/,
			replace:
				'$1globalThis.BetterGrokBot?$6.jsx(globalThis.BetterGrokBot.component("startup","SettingsRows",{React:$5,jsx:$6.jsx,Row:$4,Toggle:$3,Select:$2}),{}):null,',
		},
	],
});

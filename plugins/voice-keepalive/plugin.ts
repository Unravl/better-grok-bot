import { definePlugin } from "@better-grok-bot/sdk";

const APP_CHUNK = /^assets\/index\.eager-app-[\w-]+\.js$/;
const SETTINGS_VIEW_CHUNK = /^assets\/chunk-view-[\w-]+\.js$/;

export default definePlugin({
	id: "voice-keepalive",
	name: "Voice Keepalive",
	description:
		"Reconnects voice calls when the line drops (e.g. after ~15 minutes of silence) instead of hanging up (Settings → General → System → Keep-alive voice).",
	version: "0.2.0",
	apiVersion: 1,
	runtime: "runtime.ts",
	patches: [
		{
			// Voice-call store `onClosed`: redial instead of ending the call when the line drops.
			// The app gates this on the `sand_voice_reconnect` Statsig gate.
			id: "reconnect-on-close",
			file: APP_CHUNK,
			find: /(\i)\.featureGates\(\)\?\.sand_voice_reconnect===!0&&(\i)\.closeIsRecoverable\((\i),/,
			replace:
				'(globalThis.BetterGrokBot?.call("voice-keepalive","shouldReconnect",$3)??$1.featureGates()?.sand_voice_reconnect===!0)&&$2.closeIsRecoverable($3,',
		},
		{
			// `mayReconnect` for the first dial and every redial: marks a dropped live socket as recoverable.
			id: "session-may-reconnect",
			file: APP_CHUNK,
			find: /mayReconnect:\(\)=>(\i)\.featureGates\(\)\?\.sand_voice_reconnect===!0/,
			replace:
				'mayReconnect:()=>globalThis.BetterGrokBot?.call("voice-keepalive","shouldReconnect")??$1.featureGates()?.sand_voice_reconnect===!0',
			expect: 2,
		},
		{
			// Settings → General → System: the Keep-alive voice row right after the Microphone row (and the
			// rows other plugins render inside it). Toggle and Row come from the Hardware Acceleration row;
			// React from the Network Debugger row; the section is the one gated on "grok_bot_network_debugger".
			id: "settings-row",
			file: SETTINGS_VIEW_CHUNK,
			find: /(\.jsx\((\i),\{isChecked:\i,isDisabled:\i,label:\i,onToggle:\i,size:"md"\}\)(?:(?!isChecked:)[^])*?\.jsx\((\i),\{anchorId:"hardware-acceleration",description:[^]*?=(\i)\.useState\(!1\)[^]*?\("grok_bot_network_debugger"\)[^]*?(\i)\.jsxs\(\i,\{title:\i,children:\[)(\i),/,
			replace:
				'$1$6,globalThis.BetterGrokBot?$5.jsx(globalThis.BetterGrokBot.component("voice-keepalive","SettingsRow",{React:$4,jsx:$5.jsx,Row:$3,Toggle:$2}),{}):null,',
		},
	],
});

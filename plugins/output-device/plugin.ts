import { definePlugin } from "@better-grok-bot/sdk";

const APP_CHUNK = /^assets\/index\.eager-app-[\w-]+\.js$/;
const SETTINGS_VIEW_CHUNK = /^assets\/chunk-view-[\w-]+\.js$/;

export default definePlugin({
	id: "output-device",
	name: "Output Device",
	description: "Choose which speaker or headset voice mode plays through (Settings → General → Speaker).",
	version: "0.1.0",
	apiVersion: 1,
	runtime: "runtime.ts",
	patches: [
		{
			// Voice call audio engine: the context that plays every speech chunk.
			id: "voice-call-context",
			file: APP_CHUNK,
			find: /(\i)=new AudioContext\((\{sampleRate:\i\})\);(const \i=\1\.createMediaStreamSource\(\i\),\i=\1\.createScriptProcessor\()/,
			replace:
				'$1=globalThis.BetterGrokBot?.call("output-device","createAudioContext",$2,"voice-call")??new AudioContext($2);$3',
		},
		{
			// Chime played when a voice call ends.
			id: "hangup-chime-context",
			file: APP_CHUNK,
			find: /(\i)=new AudioContext\(\{sampleRate:(\i)\}\)(,\i=\1\.createBuffer\(1,\i\.length,\2\))/,
			replace:
				'$1=globalThis.BetterGrokBot?.call("output-device","createAudioContext",{sampleRate:$2},"voice-hangup")??new AudioContext({sampleRate:$2})$3',
		},
		{
			// `voicePreviewPlayer`: plays the greeting sample when a voice is previewed in the voice picker.
			id: "voice-preview-element",
			file: APP_CHUNK,
			find: /const (\i)=new Audio;(return \1\.addEventListener\("ended",)/,
			replace: 'const $1=new Audio;globalThis.BetterGrokBot?.call("output-device","trackMediaElement",$1,"voice-preview");$2',
		},
		{
			// Settings → General: render the Speaker row right after the Microphone row
			// by making the Microphone row component return both rows.
			id: "speaker-settings-row",
			file: SETTINGS_VIEW_CHUNK,
			find: /(\{_:(\i)\}=\i\(\),\{inputDeviceId:\i\}=\i\(\),[^]*?=(\i)\.useSyncExternalStore\([^]*?(\i)\.jsx\((\i),\{anchorId:"microphone",variant:"card",children:\4\.jsx\((\i),\{"aria-label":\i,onValueChange:\i,options:\i,placement:"bottom-end",size:"lg",value:\i,variant:"ghost"\}\)\}\),[^{}]*?\):(\i)=\i\[\d+\],)\7\}/,
			replace:
				'$1globalThis.BetterGrokBot?$4.jsxs($4.Fragment,{children:[$7,$4.jsx(globalThis.BetterGrokBot.component("output-device","SpeakerRow",{React:$3,jsx:$4.jsx,Row:$5,Select:$6,translate:$2}),{})]}):$7}',
		},
	],
});

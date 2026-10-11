import { definePlugin } from "@better-grok-bot/sdk";

const APP_CHUNK = /^assets\/index\.eager-app-[\w-]+\.js$/;
const SETTINGS_VIEW_CHUNK = /^assets\/chunk-view-[\w-]+\.js$/;

export default definePlugin({
	id: "voice-mcp",
	name: "Voice MCP servers",
	description: "Speak to Grok Bot to use tools from your own trusted MCP servers. Manage servers in Settings → General → System → Voice MCP servers. Voice only; text chat is unchanged.",
	version: "0.1.0",
	apiVersion: 1,
	permissions: ["mcp"],
	runtime: "runtime.ts",
	styles: "styles.css",
	patches: [
		{
			// Native async dial: discover before transport creation, including reused reconnect plans.
			id: "prepare-voice-tools",
			file: APP_CHUNK,
			find: /instructions:\{text:(\i)\.instructions,greeting:\1\.greeting\},tools:\1\.tools,nudgeWire:/,
			replace: 'instructions:{text:$1.instructions,greeting:$1.greeting},tools:await (globalThis.BetterGrokBot?.call("voice-mcp","prepare",$1.tools)??$1.tools),nudgeWire:',
			expect: 1,
		},
		{
			// Retain raw completed args: the native parser defaults missing/non-string args to "{}".
			// capture returns the original call object so native calls keep their exact semantics.
			id: "capture-completed-arguments",
			file: APP_CHUNK,
			find: /case"response.function_call_arguments.done":\{const (\i)=(\i)\((\i)\.call_id\),(\i)=\2\(\3\.name\);return \1===null\|\|\4===null\?null:\{type:(\i),call:(\{callId:\1,name:\4,argumentsJson:\2\(\3\.arguments\)\?\?"\{\}"\})\}\}/,
			replace: 'case"response.function_call_arguments.done":{const $1=$2($3.call_id),$4=$2($3.name);return $1===null||$4===null?null:{type:$5,call:globalThis.BetterGrokBot?.call("voice-mcp","capture",$6,$3.arguments)??$6}}',
			expect: 1,
		},
		{
			// Native dispatcher, after completed-arguments parsing only. Preserve built-ins/harness and
			// use the native recorder/result sender/spoken-turn queue for our results too.
			id: "dispatch-voice-tools",
			file: APP_CHUNK,
			find: /(\i)=async (\i)=>\{const\{call:(\i),toolCall:(\i),active:(\i)\}=\2;if\(\4\.name===\i\)return await \i\(\2\);if\(\4\.name===\i\)return await \i\(\2\);const (\i)=await \3\.harness\.callTool\(\{agentId:\3\.agentId,callId:\3\.callId,name:\4\.name,input:\i\(\4\.argumentsJson\),line:\i\(\3\)\}\);if\(!(\i)\.isCallUnderway\(\3\.phase\)\)return (\i);if\(\6\.kind!=="served"\)return (\i)\(\{call:\3,active:\5,toolCallId:\4\.callId,output:\6\.output\}\),\8;/,
			replace: ({ match, groups }) => {
				const [, input, call, toolCall, active, , phases, settled, send] = groups;
				const opening = `const{call:${call},toolCall:${toolCall},active:${active}}=${input};`;
				const dispatch = `if(await (globalThis.BetterGrokBot?.call("voice-mcp","dispatch",${toolCall},${active},()=>${call}.session===${active}&&${phases}.isCallUnderway(${call}.phase),output=>${send}({call:${call},active:${active},toolCallId:${toolCall}.callId,output}),${call})??false))return ${settled};`;
				return match.replace(opening, opening + dispatch);
			},
			expect: 1,
		},
		{
			// Same System section/Microphone-row anchor as Voice Keepalive. Use app React/JSX.
			id: "settings-row",
			file: SETTINGS_VIEW_CHUNK,
			find: /(\.jsx\((\i),\{isChecked:\i,isDisabled:\i,label:\i,onToggle:\i,size:"md"\}\)(?:(?!isChecked:)[^])*?\.jsx\((\i),\{anchorId:"hardware-acceleration",description:[^]*?=(\i)\.useState\(!1\)[^]*?\("grok_bot_network_debugger"\)[^]*?(\i)\.jsxs\(\i,\{title:\i,children:\[)(\i),/,
			replace: '$1$6,globalThis.BetterGrokBot?$5.jsx(globalThis.BetterGrokBot.component("voice-mcp","SettingsRow",{React:$4,jsx:$5.jsx,Row:$3,Toggle:$2}),{}):null,',
			expect: 1,
		},
	],
});

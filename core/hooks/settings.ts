import { definePlugin, IDENTIFIER_PATTERN, type PatchMatch } from "../../sdk/index.ts";

const I = IDENTIFIER_PATTERN;
const escape = (pattern: string): RegExp => new RegExp(pattern.replaceAll("\\i", I), "g");

/** Primitive name → pattern whose group 1 captures its identifier (group 2 for Button = text styles). */
const SECTION = escape(String.raw`\.jsx\((\i),\{title:\i,children:\i\}\)`);
const ROW = escape(String.raw`\.jsx\((\i),\{anchorId:"`);
const TOGGLE = escape(String.raw`\.jsx\((\i),\{isChecked:\i,isDisabled:\i,label:\i,onToggle:\i,size:"md"\}\)`);
const SELECT = escape(String.raw`\.jsx\((\i),\{"aria-label":\i,disabled:\i,onValueChange:\i,options:\i,placement:"bottom-end",size:"lg",value:`);
const BUTTON = escape(String.raw`\.jsx\((\i),\{onClick:\i,size:"md",style:(\i)\.body2,type:"button",variant:"secondary"`);

/** The single identifier every match of `pattern` captures in `group`; throws unless there is ≥ 1 match and all agree. */
function unique(name: string, pattern: RegExp, text: string, group = 1): string {
	const values = new Set<string>();
	for (const match of text.matchAll(pattern)) {
		const value = match[group];
		if (value !== undefined) values.add(value);
	}
	const [only] = values;
	if (values.size !== 1 || only === undefined) throw new Error(`settings primitive ${name} not found unambiguously`);
	return only;
}

export function settingsReplace(m: PatchMatch): string {
	const [head = "", children = "", tail = ""] = m.groups;
	const section = unique("Section", SECTION, head);
	const row = unique("Row", ROW, m.text);
	const toggle = unique("Toggle", TOGGLE, m.text);
	const select = unique("Select", SELECT, m.text);
	const button = unique("Button", BUTTON, m.text);
	const textStyles = unique("textStyles", BUTTON, m.text, 2);
	return `${head}${children},globalThis.BetterGrokBot?.settingsSection({Section:${section},Row:${row},Toggle:${toggle},Select:${select},Button:${button},textStyles:${textStyles}})??null${tail}`;
}

/** Appends the Better Grok Bot section to the end of Settings → General. */
export const settingsHook = definePlugin({
	id: "bgb-settings",
	name: "Settings section",
	description: "Adds the Better Grok Bot section to Settings → General.",
	version: "1.0.0",
	apiVersion: 1,
	patches: [
		{
			id: "general-section",
			file: /^assets\/chunk-view-[\w-]+\.js$/,
			find: /("sand-settings-general"[^]*?\.jsxs\("div",\{className:\i,children:\[)((?:\i,)*\i)(\]\}\))/,
			replace: settingsReplace,
			expect: 1,
		},
	],
});

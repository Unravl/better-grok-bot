import { definePlugin } from "../../sdk/index.ts";

const MAIN_CHUNK = /^assets\/index-[\w-]+\.js$/;
const VENDOR_CHUNK = /^assets\/index\.eager-vendor-[\w-]+\.js$/;

/** Calls the app Better Grok Bot; the renderer side lives in `loader/brand.ts`. */
export const brandHook = definePlugin({
	id: "bgb-brand",
	name: "Branding",
	description:
		"Calls the app Better Grok Bot: the window title, the messages where the app names itself, and a label at the top of the agents sidebar.",
	version: "1.0.0",
	apiVersion: 1,
	patches: [
		{
			// The window title.
			id: "window-title",
			file: /^index\.html$/,
			find: /<title>Grok Bot<\/title>/,
			replace: "<title>Better Grok Bot</title>",
			expect: 1,
		},
		{
			// Lingui `I18n.loadAndActivate`: the catalog the app activates at startup and on language change.
			id: "catalog-activate",
			file: VENDOR_CHUNK,
			find: /(loadAndActivate\(\{locale:\i,locales:\i,messages:(\i)\}\)\{)/,
			replace: "$1$2=globalThis.BetterGrokBot?.brandCatalog($2)??$2;",
			expect: 1,
		},
		{
			// Lingui `I18n._load`: catalogs loaded without activating them.
			id: "catalog-load",
			file: VENDOR_CHUNK,
			find: /(_load\((\i),(\i)\)\{)(const \i=this\._messages\[\2\];)/,
			replace: "$1$3=globalThis.BetterGrokBot?.brandCatalog($3)??$3;$4",
			expect: 1,
		},
		{
			// Agents sidebar: a label after the header row and above the primary bot tile, anchored on the
			// `sand-agents-sidebar` class and its `aside`.
			id: "sidebar-brand",
			file: MAIN_CHUNK,
			find: /((\i)=\i\("sand-agents-sidebar",\i\.className\)[^]*?(\i)\.jsxs\("aside",\{[^{}]*?className:\2,[^{}]*?children:\[\i,)/,
			replace: "$1globalThis.BetterGrokBot?.sidebarBrand()??null,",
			expect: 1,
		},
	],
});

import { definePlugin } from "../../sdk/index.ts";

/** Hands the app's React namespace (the factory's return in the common chunk) to the loader. */
export const reactHook = definePlugin({
	id: "bgb-react",
	name: "React",
	description: "Gives Better Grok Bot and plugins the app's React.",
	version: "1.0.0",
	apiVersion: 1,
	patches: [
		{
			id: "react-namespace",
			file: /^assets\/index\.eager-common-[\w-]+\.js$/,
			find: /((\i)\.useTransition=function\(\)\{return \i\.H\.useTransition\(\)\},\2\.version="\d+\.\d+\.\d+[^"]*",)\2\}/,
			replace: "$1(globalThis.BetterGrokBot?.provideReact($2),$2)}",
			expect: 1,
		},
	],
});

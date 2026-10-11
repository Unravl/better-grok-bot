import { definePlugin } from "../../sdk/index.ts";

/** `SandClientProvider`: hands the app's client (roster, auth, voice call, …) to the loader. */
export const clientHook = definePlugin({
	id: "bgb-client",
	name: "App client",
	description: "Gives plugins the app's client.",
	version: "1.0.0",
	apiVersion: 1,
	patches: [
		{
			id: "sand-client",
			file: /^assets\/index\.eager-app-[\w-]+\.js$/,
			find: /(\.createElement\((\i)\.Provider,\{value:)(\i)\.client(\},\3\.children\)\}function \i\(\)\{const \i=\i\.useContext\(\2\);return \i\(\i!=null,"useSandClient:)/,
			replace: "$1globalThis.BetterGrokBot?.provideClient($3.client)??$3.client$4",
			expect: 1,
		},
	],
});

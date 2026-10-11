import { definePlugin } from "@better-grok-bot/sdk";

const ENTRY_CHUNK = /^assets\/index-[\w-]+\.js$/;
const APP_CHUNK = /^assets\/index\.eager-app-[\w-]+\.js$/;

/**
 * Folders in the sidebar, built on the app's own sidebar sections (create, rename, delete, drag bots in and out).
 *
 * The app only shows sections when the connected computer answers `getHostSidebarSections` with a list; when it
 * answers null (no sections saved there, or a computer that does not store them) the sections store stays
 * unsupported: no "Move to new section" menu item, no drop targets, and every edit is ignored. `sections-storage`
 * routes the store's reads and writes through the runtime, which falls back to a copy kept by Better Grok Bot so
 * folders always work and persist. The other patches add folder ordering, drop-at-pointer, folder wording and the
 * header bot count that `styles.css` shows.
 */
export default definePlugin({
	id: "sidebar-folders",
	name: "Sidebar Folders",
	description: "Folders in the sidebar: create, rename and delete them, drag bots in and out, and reorder bots inside a folder.",
	version: "0.2.0",
	apiVersion: 1,
	runtime: "runtime.ts",
	styles: "styles.css",
	patches: [
		{
			// The sections store's computer adapter. The runtime answers from its own copy when the computer has none.
			id: "sections-storage",
			file: APP_CHUNK,
			find: /box:\{get:\(\)=>(\i\.desktop\.getHostSidebarSections\(\)),set:(\i)=>(\i\.desktop\.setHostSidebarSections\(\{sections:\2\}\))\}/,
			replace:
				'box:{get:()=>(p=>globalThis.BetterGrokBot?.call("sidebar-folders","readSections",p)??p)($1),set:$2=>(p=>globalThis.BetterGrokBot?.call("sidebar-folders","writeSections",p,$2)??p)($3)}',
		},
		{
			// Default name of a new section.
			id: "default-name",
			file: APP_CHUNK,
			find: /(\i="__agents__",\i="Unassigned",\i=)"New section"/,
			replace: '$1"New folder"',
		},
		{
			// English menu labels: "folder" instead of "section".
			id: "labels",
			file: APP_CHUNK,
			find: /"Dunqdd":\[\["batchCount","plural",\{"0":\["Move to new section"\],"one":\["Move to new section"\],"other":\["Move ","#"," Bots to new section"\]\}\]\]/,
			replace: '"Dunqdd":[["batchCount","plural",{"0":["New folder"],"one":["New folder"],"other":["New folder with ","#"," Bots"]}]]',
		},
		{
			id: "label-create",
			file: APP_CHUNK,
			find: /"XCRrpy":\["Create section"\]/,
			replace: '"XCRrpy":["New folder"]',
		},
		{
			id: "label-move",
			file: APP_CHUNK,
			find: /"GYkPNu":\["Move to section"\]/,
			replace: '"GYkPNu":["Move to folder"]',
		},
		{
			id: "label-actions",
			file: APP_CHUNK,
			find: /"8gtQoG":\["Section actions"\]/,
			replace: '"8gtQoG":["Folder actions"]',
		},
		{
			// Resolving sections into sidebar rows: a section's bots, filtered from the roster in roster order.
			// The runtime reorders them by the section's saved `agentIds`.
			id: "section-agent-order",
			file: APP_CHUNK,
			find: /(isCollapsed:(\i)\.isCollapsed,agents:)(\i\.filter\((\i)=>\2\.id===\i\?!\i\.has\(\4\.id\):\i\.get\(\4\.id\)===\2\.id\))/,
			replace: '$1(a=>globalThis.BetterGrokBot?.call("sidebar-folders","orderSectionAgents",$2,a)??a)($3)',
		},
		{
			// Sidebar drag-over: tells the runtime what is dragged over which drop target (for the insertion line).
			id: "drag-over",
			file: ENTRY_CHUNK,
			find: /(\i)\((\i)\?\.kind==="section"\?\2\.id:null\);const (\i)=(\i)\?\.kind==="pinned-tile";/,
			replace: 'globalThis.BetterGrokBot?.call("sidebar-folders","dragOver",$4,$2);$&',
		},
		{
			// Sidebar drop of a bot on a section body: the app moves it to the end of that section. The runtime
			// inserts it at the pointer instead (returns undefined to keep the app's behaviour).
			id: "drop-in-section",
			file: ENTRY_CHUNK,
			find: /if\((\i)\.kind==="agent"&&(\i)\.kind==="section-body"\)\{(\i)\(\1\.id,\2\.id\);return\}/,
			replace:
				'if($1.kind==="agent"&&$2.kind==="section-body"){globalThis.BetterGrokBot?.call("sidebar-folders","dropAgent",$1.id,$2.id)??$3($1.id,$2.id);return}',
		},
		{
			// A section header's bot count as `data-bgb-bot-count` on the header button (the app renders its own
			// count only while the section is collapsed); styles.css shows it after every folder name.
			id: "header-count",
			file: ENTRY_CHUNK,
			find: /count:(\i)\.agents\.length,"data-section-id":\1\.id,/,
			replace: 'count:$1.agents.length,"data-bgb-bot-count":$1.agents.length,"data-section-id":$1.id,',
			expect: 1,
		},
	],
});

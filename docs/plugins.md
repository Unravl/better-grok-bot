# Writing plugins

A Better Grok Bot plugin changes Grok Bot's web UI (its renderer). It can:

- **patch** the app's JavaScript with exact-count regex replacements at build time,
- run **renderer JavaScript** (`runtime`) that the patched code calls into,
- add **CSS** (`styles`),
- declare **settings** that Better Grok Bot stores and shows in Settings → General → Better Grok Bot,
- use Better Grok Bot **services** (`keys`, `media`) for the few things a web page can't do, after the user grants them.

Better Grok Bot never modifies the installed app. Each build copies the app's renderer into the Better Grok
Bot data folder, applies the patches of every enabled plugin, injects the loader and plugin scripts, and makes
Grok Bot load that private copy at its next start. When Grok Bot updates, Better Grok Bot rebuilds; a plugin
whose patches no longer match is turned off for that app version (`patch-failed`) and the rest keep working.

The four bundled plugins in [`plugins/`](../plugins) (`output-device`, `push-to-talk`, `startup`,
`voice-keepalive`) are complete, working examples of everything below.

## Anatomy

A plugin is a folder:

```text
my-plugin/
  plugin.ts      definition: id, metadata, settings, permissions, patches
  runtime.ts     renderer code (optional)
  styles.css     renderer CSS (optional)
```

`bgb plugin build` turns it into a package, `<id>-<version>.bgbplugin`: a zip with `plugin.json` (the
serialized definition), `runtime.js` (the runtime bundled as a browser IIFE with an inline source map) and
`styles.css` at its root. Users install packages; the TypeScript sources never run on their computer.

## The definition (`plugin.ts`)

```ts
import { definePlugin } from "@better-grok-bot/sdk";

export default definePlugin({
	id: "hello-greeting",
	name: "Hello Greeting",
	description: "Greets you in the voice call controls.",
	version: "1.0.0",
	authors: ["Your Name"],
	license: "MIT",
	homepage: "https://github.com/you/hello-greeting",
	apiVersion: 1,
	platforms: ["darwin", "win32", "linux"],
	permissions: [],
	settings: {
		greeting: { type: "string", label: "Greeting", default: "Hello" },
	},
	patches: [
		/* see Patches */
	],
	runtime: "runtime.ts",
	styles: "styles.css",
});
```

|Field|Required|Meaning|
|---|---|---|
|`id`|yes|Lowercase kebab-case, 2–48 characters. `bgb`, `bgb-*` and the bundled ids are reserved.|
|`name`, `description`|yes|Shown in Settings and `bgb plugins`.|
|`version`|yes|Semantic version (`1.2.3`, `1.2.3-beta.1`).|
|`apiVersion`|yes|Always `1`.|
|`authors`, `license`, `homepage`|no|Metadata.|
|`platforms`|no|Operating systems the plugin supports (`darwin`, `win32`, `linux`); default all. Elsewhere it shows as "Not available on this OS".|
|`permissions`|no|Services the plugin uses: `keys`, `media` (see Permissions and services).|
|`settings`|no|Settings schema (see Settings).|
|`patches`|no|Renderer patches (see Patches).|
|`runtime`|no|Path of the renderer entry, relative to the plugin folder.|
|`styles`|no|Path of a CSS file, relative to the plugin folder.|

## Patches

Each patch is one regex replacement over the renderer's files:

```ts
{
	id: "voice-preview-element",
	file: /^assets\/index\.eager-app-[\w-]+\.js$/,
	find: /const (\i)=new Audio;(return \1\.addEventListener\("ended",)/,
	replace: 'const $1=new Audio;globalThis.BetterGrokBot?.call("output-device","trackMediaElement",$1,"voice-preview");$2',
	expect: 1,
}
```

- `file` selects renderer-relative paths with forward slashes. Chunk names carry a content hash, so match
  the hash with `[\w-]+`.
- `find` is applied with the `g` flag (added for you). `\i` matches one minified identifier (`[\w$]+`);
  capture identifiers with `(\i)` and refer back with `\1`.
- `replace` uses `String.prototype.replace` syntax: `$1`–`$99`, `$<name>`, `$&`, `$$`.
- `expect` is the exact number of matches across all selected files (default `1`). A different count, in
  any patch, drops the whole plugin for that build: none of its patches apply and its runtime and CSS are
  not injected. Later plugins see the edits of earlier ones (core hooks first, then bundled, community and
  dev plugins, each group by id).

### Writing anchors that survive updates

Minified identifiers change with every Grok Bot release; string literals, property names and browser API
names usually don't. Anchor on those, match identifiers with `\i`, and keep each match as short as the
uniqueness of the anchor allows. `[^]*?` (lazy "anything") bridges between two stable anchors in the same
function.

To read the code you are patching, extract a copy of the renderer:

```sh
bgb renderer extract ./renderer            # pristine app files
bgb renderer extract ./renderer --patched  # the current build, with every active plugin applied
```

Never share or commit these files: they are the app's code. Share plugin source only.

### The guard pattern

Patched code must keep working when the loader or your plugin is missing, disabled or broken. Call into
your runtime only through the guard, with the original expression as the fallback:

```js
x=globalThis.BetterGrokBot?.call("my-plugin","makeThing",args)??originalExpression
```

`BetterGrokBot.call(id, name, ...args)` never throws: it returns `undefined` when the plugin isn't loaded,
the export is missing or not a function, or it throws (logged once). Return `undefined` from your export to
keep the app's own value.

Render UI through `BetterGrokBot.component`, passing the app's React, its `jsx` function and any app
components you captured:

```js
globalThis.BetterGrokBot?R.jsx(globalThis.BetterGrokBot.component("my-plugin","Row",{React:L,jsx:R.jsx,Row:se}),{}):null
```

`component(id, name, deps)` returns a component that stays the same across calls. It builds it once from
your export `name` (a `ComponentFactory`) and wraps it in an error boundary: a missing, failed or throwing
component renders nothing. `deps.React` and `deps.jsx` default to the app's React.

### Community plugin restrictions

Installed (community) and dev plugins are held to stricter rules than the bundled ones:

- Replacements are strings only; `` $` `` and `$'` are not allowed. (Bundled plugins and core hooks may
  use function replacers.)
- Patches may not select `index.html` or anything under `assets/bgb/` (Better Grok Bot's own files).
- Flags are limited to `i`, `m`, `s`, `u`.
- Patches run in a separate worker with a 10 second budget per plugin covering file selection, matching
  and replacement; a regex that backtracks catastrophically fails only its own plugin.
- Size limits: at most 200 patches; each `find`/`file` source at most 4 KiB; each replacement at most
  64 KiB; at most 64 MiB of selected input; each edited file at most twice its original size plus 1 MiB; all
  edits together at most 128 MiB.
- Package limits: `plugin.json` ≤ 1 MiB, `runtime.js` ≤ 5 MiB, `styles.css` ≤ 2 MiB; a package holds at most
  2,000 entries, each ≤ 20 MiB, 50 MiB in total, with paths of at most 255 characters and 16 segments, and no
  symlinks.

## The runtime (`runtime.ts`)

The runtime is bundled into a classic browser script that runs before the app's own code, in the app's
renderer (no Node.js). It registers the plugin's exports:

```ts
import type { ComponentFactory, PluginContext } from "@better-grok-bot/sdk";

globalThis.BetterGrokBot?.define("hello-greeting", (ctx: PluginContext) => {
	ctx.log.info("loaded for Grok Bot", ctx.manifest.appVersion);

	const greet = (name: unknown): string => `${String(ctx.settings.get("greeting"))}, ${String(name)}!`;

	const Banner: ComponentFactory = ({ React, jsx }) =>
		function HelloBanner() {
			const greeting = React.useSyncExternalStore(
				(onChange) => ctx.settings.subscribe("greeting", onChange),
				() => ctx.settings.get("greeting"),
			);
			return jsx("span", { children: String(greeting) });
		};

	return { greet, Banner };
});
```

`define(id, factory)` is accepted only from the plugin's own injected script and only when the build lists
the plugin as active; the factory runs at once and a throw marks the plugin `runtime-failed`. Value imports
from `@better-grok-bot/sdk` (for example `WATCHABLE_CODES`) are bundled into your script.

### The plugin context

|Member|What it is|
|---|---|
|`ctx.id`|Your plugin id.|
|`ctx.log`|`info`/`warn`/`error`, printed to the renderer console prefixed `[bgb:<id>]`.|
|`ctx.storage`|`get(key, fallback)`, `set(key, value)`, `subscribe(key, listener)`: JSON values in `localStorage` under `bgb:<id>:<key>`. `subscribe` fires after `set` in this window and when another window changes the key.|
|`ctx.settings`|Your settings schema's values (see Settings).|
|`ctx.manifest`|The build manifest: `platform`, `appVersion`, `buildKey`, `bgbVersion` and every plugin's status.|
|`ctx.app.React`, `ctx.app.jsx`|The app's React namespace and `jsx` function (from the `bgb-react` core hook).|
|`ctx.app.ui`|The settings page's `Section`, `Row`, `Toggle`, `Select`, `Button` components and `textStyles` (from the `bgb-settings` core hook), once Settings has opened.|
|`ctx.app.client`, `ctx.app.onClient(listener)`|The app's client (roster, auth, voice call, window events; from the `bgb-client` core hook). `onClient` calls `listener` in a microtask with the current client, then with every new client (the app can replace it), and returns an unsubscribe function.|
|`ctx.services`|`keys` and `media` (see Permissions and services).|

The runtime global `BetterGrokBot` also offers `BetterGrokBot.React` (the app's React), `status()` (every
plugin's state with errors, including runtime failures in this window), `bridgeState()` and `version`.

### Core hooks

Three core hooks (`bgb-react`, `bgb-settings`, `bgb-client`) are always active and patch the app first.
They hand the app's React, its settings primitives and its client to the loader, so your plugin can use
them without patching for them. They never change what the app does.

## Settings

Declare settings and Better Grok Bot stores, validates and shows them: while your plugin is active, its row
in Settings → General → Better Grok Bot is followed by one row per field.

```ts
settings: {
	enabled: { type: "boolean", label: "Show the banner", default: true },
	style: { type: "select", label: "Style", default: "short", options: [
		{ value: "short", label: "Short" },
		{ value: "long", label: "Long" },
	] },
	size: { type: "number", label: "Size", default: 12, min: 8, max: 32, step: 1 },
	greeting: { type: "string", label: "Greeting", default: "Hello", placeholder: "Hello" },
	shortcut: { type: "key", label: "Shortcut", default: "F8" },
},
```

|Type|Control|Valid value|
|---|---|---|
|`boolean`|Toggle|`true` / `false`|
|`select`|Select|one of the `options` values|
|`number`|number input|a finite number within `min`/`max`|
|`string`|text input|any string|
|`key`|key recorder (Esc cancels)|a non-empty `KeyboardEvent.code`|

Every field has a `label`, an optional `description` and a `default` that must itself be valid.

`ctx.settings.get(name)` returns the stored value when it is valid for its field, else the default.
`ctx.settings.set(name, value)` throws a `RangeError` for an unknown name or an invalid value, else stores it
(under `localStorage` key `bgb:<id>:setting:<name>`) and notifies `ctx.settings.subscribe(name, listener)`.

## Permissions and services

A web page can't see keys pressed while the app is in the background or change other apps' volume. Better
Grok Bot does both through its background agent and a small native helper, as services. A plugin declares
the services it uses in `permissions`; the user grants them when installing the plugin (and again when an
update asks for more). Reading `ctx.services.keys` or `ctx.services.media` without the grant throws a
`PermissionError`.

|Permission|Shown to the user as|
|---|---|
|`keys`|listen to a key while Grok Bot is in the background|
|`media`|lower other apps' volume|

### `ctx.services.keys`

```ts
const stop = ctx.services.keys.watch("AltRight", (down) => {
	if (down) startTalking();
	else stopTalking();
});
```

- `watch(code, listener)` reports one key, by `KeyboardEvent.code`, while Grok Bot is in the background (and
  in the foreground; DOM key events are usually simpler there). It returns a function that stops watching.
  Watch only while you need it: an empty watch set lets the helper turn its key listener off.
- `listener(false)` also arrives when the connection to the agent or the helper drops while the key is down,
  so treat it exactly like a key release.
- Only modifier, function, lock and media keys can be watched (`WATCHABLE_CODES` in the SDK): `AltLeft`,
  `AltRight`, `ControlLeft`, `ControlRight`, `ShiftLeft`, `ShiftRight`, `MetaLeft`, `MetaRight`, `Fn` (macOS),
  `CapsLock`, `NumLock`, `ScrollLock`, `F1`–`F24`, `Pause`, `Insert`, `ContextMenu`, `MediaPlayPause`,
  `MediaStop`, `MediaTrackNext`, `MediaTrackPrevious`, `AudioVolumeMute`. Each OS helper watches a subset
  (`HELPER_CODES[ctx.manifest.platform]`; macOS: the modifiers, `Fn` and `F1`–`F20`). Check both before
  offering background use of a key, and tell the user when a key works only while Grok Bot is focused.
- `onChord(listener)` reports `code` when another key goes down while that watched key is held, at most once
  per hold: the key was used in a shortcut (Command-Tab, Option-letter).
- `state` is `unsupported`, `needs-install`, `installing`, `starting`, `needs-permission`, `ready` or `error`,
  with an optional `detail`; `subscribe(listener)` reports changes. `install()` installs the helper (macOS
  needs this once; Windows and Linux download and start it on demand). On macOS, `needs-permission` means the
  user must allow Better Grok Bot Helper in System Settings → Privacy & Security → Input Monitoring. Wayland
  sessions are `unsupported`.

### `ctx.services.media`

`duck(level)` asks for other apps' music to play at `level` (0–1) of its own volume; `1` releases. Requests
combine: the music plays at the lowest level any plugin in any window asks for. The helper lowers Spotify and
Music on macOS, Spotify, Apple Music and iTunes on Windows; on Linux the agent lowers Spotify through
PulseAudio/PipeWire (`pactl` 16 or newer). It restores the original volume with a short fade, and stops
managing a player once the user changes its volume by hand. `state` is `unsupported`, `needs-install`,
`ready` or `error`.

## Trust and safety

Plugins are trusted code. Install only plugins whose authors you trust, as you would any program.

- Installed `.bgbplugin` packages run JavaScript only inside Grok Bot's renderer, never as a program on your
  computer. All plugins share that renderer's one JavaScript realm, with the app and with each other.
- Permissions are consent and transparency for honest plugins, not isolation. Any script in the renderer can
  read the bridge token from `assets/bgb/boot.js`, and the bridge authorizes a renderer connection, not an
  individual plugin, so a malicious plugin can skip the permission check by calling bridge methods directly.
- The hard limits live in the agent: a fixed set of bridge methods and the `WATCHABLE_CODES` list. The bridge
  never streams character keys, so no plugin can log your typing in other apps. A renderer plugin can,
  however, read anything Grok Bot shows and do anything Grok Bot's page can do.
- `bgb plugin build` and `bgb dev` evaluate your local `plugin.ts` on your computer with your user rights;
  only run them on source you trust.

## Develop

```sh
bgb plugin new hello-greeting --dir ./hello-greeting   # plugin.ts, runtime.ts, README.md, tsconfig.json, bgb-sdk/
bgb dev ./hello-greeting                               # build, load, and rebuild on every change
bgb plugin build ./hello-greeting --out ./hello-greeting-1.0.0.bgbplugin
```

`bgb plugin new` writes a starter plugin with a copy of the SDK sources (`bgb-sdk/`) and a `tsconfig.json`
mapping `@better-grok-bot/sdk` to it, so editors type-check without installing anything.

`bgb dev <dir>` asks for confirmation (it runs `plugin.ts` on every change), builds the plugin, adds it as a
dev plugin and tails the agent log until Ctrl+C, then removes it again. Every saved change rebuilds Grok
Bot's renderer copy and reloads open Grok Bot windows. A dev plugin with the id of an installed plugin
replaces it while it is loaded.

Diagnose with:

- `bgb plugins` and `bgb build --json`: each plugin's state and errors, including the patch id and match
  count of a `patch-failed` plugin.
- `bgb logs -f`: the agent log.
- The renderer console (launch Grok Bot with `--remote-debugging-port=9333` and open
  `http://127.0.0.1:9333`): lines prefixed `[bgb]` and `[bgb:<id>]`, and `BetterGrokBot.status()`.

## Publish

Attach exactly one `.bgbplugin` file to a GitHub release:

```sh
bgb plugin build . --out ./hello-greeting-1.0.0.bgbplugin
gh release create v1.0.0 ./hello-greeting-1.0.0.bgbplugin
```

Users install it with:

```sh
bgb plugins install github:you/hello-greeting          # latest release
bgb plugins install github:you/hello-greeting@v1.0.0   # a specific tag
```

or by pasting `github:you/hello-greeting` into Settings → General → Better Grok Bot → Install plugin. A
plugin can also be installed from a folder, a `.bgbplugin`/`.zip` file or an `https://` URL of a package (at
most 20 MB). Better Grok Bot shows the requested permissions before installing, remembers the source, and
`bgb plugins update <id>` (or the plugin's Update button) installs a newer release from it, asking again only
when the new version requests more permissions.

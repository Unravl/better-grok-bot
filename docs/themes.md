# Themes

A theme is one CSS file that restyles Grok Bot. Themes need no build step and apply live: enabling,
disabling or editing an enabled theme changes open Grok Bot windows within a moment, without a reload.

## File format

A theme is a file named `<id>.theme.css`; its id is the file name without `.theme.css`. It starts with a
header comment in the BetterDiscord style:

```css
/**
 * @name Midnight
 * @description Darker surfaces and a blue accent.
 * @author Your Name
 * @version 1.0.0
 */

:root:root {
	--cursor-text-primary: #e6edf3;
}
```

|Tag|Required|Meaning|
|---|---|---|
|`@name`|yes|Shown in Settings and `bgb themes`.|
|`@description`|no|Shown under the name.|
|`@author`|no|Shown in `bgb themes`.|
|`@version`|no|Shown in `bgb themes`.|

The header must be the first thing in the file. A theme without `@name`, larger than 2 MB, or unreadable is
listed as invalid with the reason (`missing @name header`, `larger than 2 MB`, `unreadable: …`); it can't be
enabled and is never injected.

## Install and manage

```sh
bgb themes install ./midnight.theme.css                         # a file …
bgb themes install https://example.com/midnight.theme.css       # … or an https URL (at most 2 MB)
bgb themes                                                      # list themes, enabled or not, valid or not
bgb themes enable midnight
bgb themes disable midnight
bgb themes uninstall midnight
```

Themes live in the `themes` folder of the Better Grok Bot data folder (Settings → General → Better Grok Bot →
Open folder → Themes). Copying a `.theme.css` file there installs it too. Every theme has a toggle in
Settings → General → Better Grok Bot.

## Live reload

The background agent watches the themes folder. When a theme is enabled, disabled or edited, it sends the
enabled themes' CSS to every open Grok Bot window, which replaces its `<style data-bgb-style="theme:<id>">`
elements in place. The next renderer build also includes the enabled themes, so they apply from the first
paint when Grok Bot starts. Keep a theme file open in your editor, save, and watch Grok Bot change.

## Writing a theme

- Find selectors and CSS custom properties with the renderer's developer tools (launch Grok Bot with
  `--remote-debugging-port=9333` and open `http://127.0.0.1:9333`), or read the app's stylesheet in a copy
  extracted with `bgb renderer extract <dir>`. Never share or commit extracted files.
- Theme styles can end up before the app's own stylesheet in the document, so an equally specific app rule
  wins. Override custom properties with a more specific selector (`:root:root { … }`), raise specificity, or
  use `!important`.
- Prefer custom properties and stable attribute or `aria-*` selectors; generated class names can change with
  any Grok Bot update.
- Grok Bot's Content-Security-Policy applies: images may come from `https:` and `data:` URLs, fonts only from
  `data:` URLs, and `@import` of remote stylesheets is blocked. Inline what you need.
- Themes are CSS only. For behavior, write a plugin (see [plugins.md](plugins.md)); a plugin can ship CSS
  too.

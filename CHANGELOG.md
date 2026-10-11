# Changelog

All notable changes to Better Grok Bot are documented here.

## [Unreleased]

## [0.2.0] - 2026-10-11

### Added

- Sidebar Folders turns the app's sidebar sections into folders: create them (also by right-clicking empty sidebar space), rename and delete them, drag bots in and out, and drop a bot at the pointer to reorder a folder. When the connected computer stores no sections, Better Grok Bot keeps the folders itself, so they always work and survive restarts.
- Voice Dock docks the voice-call controls (status, call settings, transcript, mute, hang up) in the sidebar footer with compact buttons, so they stay reachable from any bot; the chat view's floating call panel is hidden while docked and is used again when the sidebar is collapsed.
- Weekly Usage shows your weekly usage as a bar with its percentage above Connect Apps in the sidebar, with the days until it resets on hover. It reads the same usage summary as Settings → Usage, asks the app to refresh it every 5 minutes while shown, and stays hidden for enterprise seats and plans without a weekly limit.
- Bot Instructions adds an Instructions editor to the info pane's Overview tab for bots you own or manage, where the app shows its own description editor only for team bots. It saves the bot's description with the app's own call; ⌘/Ctrl+Enter saves and Escape cancels.
- Chat Search adds a button to bot conversation headers, searches earlier history with the app's native finder, and jumps between highlighted matches. History loading reports incomplete results, supports retry, and stops requesting pages when search closes or the conversation changes.
- The app is called Better Grok Bot (core hook `bgb-brand`, always on): the window title, the messages where the app names itself (welcome, settings, updates, restart prompts) in every language, and a label at the top of the agents sidebar; the assistant keeps the name Grok Bot.
- Installers accept `BGB_APP_PATH`, passed to `bgb setup --app` as one argument so paths with spaces work; `BGB_SETUP_ARGS` is for simple space-separated flags only.
- Voice MCP adds Settings → General → System → Voice MCP servers for named stdio, Streamable HTTP and legacy SSE servers, with JSON args/env or authentication headers and optional stdio working directories. New servers save disabled; connection testing does not execute tools. Explicitly enable and manually rejoin/start voice to use tools; normal text chat is unchanged. Local runtimes must be installed, and OAuth is not supported.
- BGB Sidebar Folders adds a disabled-by-default Voice MCP preset and standalone `bgb [--data-dir <DATA>] mcp sidebar-folders` stdio server to list bots/folders, create folders, move bots and delete containers without deleting bots. Setup preserves existing choices and user ID collisions. Voice actions target their originating window; context-free external clients refuse multi-window ambiguity. Enable both plugins and the preset, manually open the updated app and start a new voice conversation. Sidebar actions report success only after the owned native operation or the fallback copy's persistence is confirmed; failures, timeouts and client resets can have unknown outcomes and are not automatically replayed. Their errors keep their codes and candidate details.
- The `mcp` permission and required `ctx.services.mcp` SDK service provide list/save/remove/connect/tools/call with browser-safe types, enabled-only tool access, deadlines, explicit failures and preserved MCP content/structured results/error flags. Full configurations persist host-wide in unencrypted `DATA/mcp.json` (mode `0600`). Enabled tools act without per-call prompts; schemas/results reach the remote voice model. Plugin-ID grant checks are not a sandbox against plugins sharing the renderer and bridge token.
- Plugin storage: `ctx.storage.set(key, value, { requirePersistence: true })` rejects known persistence errors without updating the cache; the default is unchanged.

### Fixed

- Windows `uninstall --purge` deletes everything outside `DATA\bin` right away (unlinking the `current` junction without following it), then removes the rest once `bgb.exe` has exited with a `cmd.exe` that reads the path from the environment through delayed expansion, so characters in the path (`&`, `%`, `^`) cannot change the command. If DATA survives, the reason is kept in `%TEMP%\bgb-uninstall.log`.
- `uninstall --purge` keeps DATA while a hook it does not own still points at this install's renderer.
- The build key hashes exactly the plugin files the build assembles, so a plugin replaced mid-build can no longer leave a cached renderer with stale plugin code.
- Plugin install, update and uninstall swap the package and commit its grant as one step under the build lock, so concurrent operations cannot leave mismatched grants or bring back an uninstalled plugin; approving an update's new permissions fails if the plugin was uninstalled or replaced after the prompt.
- The Grok Bot version read from `app.asar` must be a plain version, and builds refuse destinations outside `DATA/builds`.
- Windows builds and checks the new `current` junction before swapping it in; a failed publish no longer leaves `current` missing.
- A failed macOS helper install (including `launchctl bootstrap`) is removed and reported as needs-install with its error, and the next install retries.
- When the update watchdog cannot restore the previous version it keeps the pending update, records the manual recovery step and says so, instead of claiming a rollback.
- macOS app discovery tries every Spotlight result instead of failing on the first unusable one.
- A window that starts watching a key that is already held gets an initial key-down.
- An open window's plugin settings stay on the loaded schema until reload, so settings added by an update no longer hide the settings section.
- A plugin that failed in this window shows its toggle off once disabled and can be re-enabled without reloading.
- A slow theme-styles reply after reconnecting no longer undoes a newer live theme change.
- Output Device serializes sink switches and reconciles to the latest choice, so audio no longer stays on a previously chosen speaker.
- Push to Talk returns music to the "while I talk" level when the key is pressed again during the release tail.
- Native helpers: a modifier released while the key listener starts is no longer latched as held; key events can no longer arrive release-before-down; a Windows keyboard hook that fails to install is reported as an error and retried; Windows ducking keeps a player's original volume after a transient volume-set failure.
- `fetch-upstream` keeps downloads inside its cache, fails when the Windows installer fails, and checks the installed Grok Bot version; the canary issue tracks only the currently published commit.

## [0.1.0] - 2026-10-11

### Added

- Initial release: `bgb` CLI and background agent, plugin/theme system, bundled plugins (output-device, push-to-talk, startup, voice-keepalive), native key/media helpers, self-update.

# Better Grok Bot

Plugins, themes and hooks for the [Grok Bot](https://x.ai/bot) desktop app on macOS, Windows and Linux.

Better Grok Bot (BGB) is a single command-line program, `bgb`, plus a small background agent. You install
it once, then open Grok Bot the way you always do: BGB loads its plugins and themes into the app and adds a
**Better Grok Bot** section to **Settings → General**, where you manage everything. The app itself is called Better Grok Bot while BGB is installed (window
title, its own messages, a label in the agents sidebar); the assistant keeps the name Grok Bot.

## Install

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Unravl/better-grok-bot/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Unravl/better-grok-bot/main/install.ps1 | iex
```

The installer downloads the release for your OS and CPU, checks its SHA-256, and runs `bgb setup`. Setup
asks before restarting a running Grok Bot. Set `BGB_VERSION=1.2.3` to install a specific version.

Grok Bot must already be installed. Releases are not code-signed yet; the installer clears the macOS
download quarantine for you.

### Verified on

| OS | Status |
|---|---|
| macOS (Apple silicon) | Verified on a logged-in Mac (install, Settings section, plugins, themes, reloads); background push-to-talk helper check pending |
| Windows 10/11 | CI-verified; logged-in manual check pending |
| Linux (X11, deb/AppImage) | CI-verified; logged-in manual check pending |

Every release is built and tested end to end on all three systems by GitHub Actions against the current
Grok Bot release, and a scheduled canary re-tests every new Grok Bot version. See
[docs/releasing.md](docs/releasing.md) for the manual checklist.

## What setup changes

Grok Bot itself is never modified; its files are integrity-checked. BGB keeps a private, patched copy of
Grok Bot's interface files and points Grok Bot at it through the `VITE_DEV_SERVER_URL` variable the app
already reads.

| | macOS | Windows | Linux |
|---|---|---|---|
| Data folder (`DATA`) | `~/Library/Application Support/BetterGrokBot` | `%LOCALAPPDATA%\BetterGrokBot` | `~/.local/share/BetterGrokBot` |
| `bgb` command | `~/.local/bin/bgb` (link) | `DATA\bin` added to your user `Path` | `~/.local/bin/bgb` (link) |
| How Grok Bot finds BGB | `launchctl setenv VITE_DEV_SERVER_URL …` | user environment variable `VITE_DEV_SERVER_URL` | a copy of `grok-bot.desktop` in `~/.local/share/applications` that sets the variable |
| Background agent | LaunchAgent `io.github.unravl.bettergrokbot.agent` | started at login (Run key `BetterGrokBot`) | started at login (`~/.config/autostart/better-grok-bot.desktop`) |
| Login item | LaunchAgent `io.github.unravl.bettergrokbot.login` | the same Run key | the same autostart entry |

`BGB_DATA_DIR` (or `bgb --data-dir <path>`) moves the data folder.

On macOS and Windows the variable is set for your whole user session, so another Electron app that also
reads `VITE_DEV_SERVER_URL` would try to load BGB's page. `bgb doctor` lists installed apps that read it.

On macOS, `launchctl setenv` does not survive a reboot; the agent sets it again when you log in. If Grok Bot
opens at login before the agent has done that (for example through Grok Bot's own login item), that window
runs without BGB: `bgb restart` fixes it, and BGB's own "Open Grok Bot at login" setting avoids it.

## Using it

Open Grok Bot → **Settings → General** and scroll to **Better Grok Bot**. There you can:

- see whether the background agent is connected, and reload after changes ("Reload to apply")
- turn "Open Grok Bot at login" and automatic BGB updates on or off
- enable, disable, update and remove plugins, and change their settings
- install a plugin from a link or `github:owner/repo`
- turn themes on and off (they apply instantly)
- open the plugins, themes and logs folders

In a bot conversation, click **Search** in the chat header to find previous text. Use the arrows or
**Enter / Shift+Enter** to jump between highlighted matches; **Escape** closes search. Earlier history
loads while search is open. Results remain incomplete until loading finishes; a failed load shows a retry button.

Everything is also available from the command line.

| Command | What it does |
|---|---|
| `bgb setup [--yes] [--no-restart] [--force] [--app <path>] [--no-autostart] [--no-hook]` | Install BGB for this user |
| `bgb uninstall [--purge] [--yes]` | Remove the hook, autostart and agent (`--purge` also deletes `DATA`) |
| `bgb start` / `bgb stop` | Start or stop the background agent |
| `bgb restart [--yes] [--force] [-- <app args>]` | Quit Grok Bot and open it with BGB |
| `bgb status [--json]` | Agent, hook, app, build, plugins, themes, update |
| `bgb doctor` | Check the install and explain problems |
| `bgb update [--check]` | Update BGB now |
| `bgb logs [-f]` | Print or follow the agent log |
| `bgb [--data-dir <DATA>] mcp sidebar-folders` | Run the built-in Sidebar Folders MCP server over stdio (global flags go before `mcp`) |
| `bgb plugins [list]` | List plugins and their states |
| `bgb plugins enable\|disable <id>` | Turn a plugin on or off |
| `bgb plugins install <path\|url\|github:owner/repo[@tag]> [--yes]` | Install a community plugin |
| `bgb plugins uninstall <id>` / `bgb plugins update [<id>] [--yes]` | Remove or update community plugins |
| `bgb themes [list]`, `themes enable\|disable <id>`, `themes install <path\|url>`, `themes uninstall <id>` | Manage themes |
| `bgb build [--force] [--app <path>] [--json]` | Rebuild the patched interface now |
| `bgb check --asar <path> [--json]` | Test the core and bundled plugins against a Grok Bot `app.asar` |
| `bgb plugin new <id> [--dir <path>]` / `bgb plugin build [<dir>] [--out <file>]` | Create and package a plugin |
| `bgb dev <dir> [--yes]` | Load a plugin from source and rebuild on every change |
| `bgb renderer extract <dir> [--patched]` | Write Grok Bot's interface files for finding patch anchors (never share them) |
| `bgb config get <key>` / `bgb config set <key> <value>` | `bridgePort`, `autoUpdate`, `openAtLogin`, `appPath` |

Exit codes: 0 ok, 1 error, 2 usage error, 3 `check` found failures.

## Bundled plugins

| Plugin | What it does |
|---|---|
| Output Device | Choose which speaker or headset voice mode plays through (Settings → General → System → Speaker). |
| Push to Talk | Hold a key to talk in voice calls. With the optional key helper it also works while Grok Bot is in the background, and lowers Spotify/Music while Grok talks. |
| Sidebar Folders | Drag bots up and down inside sidebar sections (folders) to reorder them. |
| Startup | Start a voice chat with a chosen bot when Grok Bot starts. |
| Voice Dock | Keeps the voice-call controls in the sidebar footer, reachable from any bot. |
| Voice Keepalive | Reconnect voice calls when the line drops instead of hanging up. |
| Voice MCP | Give voice calls tools from local or remote MCP servers (Settings → General → System → Voice MCP servers). |
| Weekly Usage | Show your weekly usage as a progress bar above Connect Apps in the sidebar. |

Push to Talk's background key and music ducking need the **key helper**, a small native program you install
from the Push to Talk settings ("Install key helper"). On macOS it asks for Input Monitoring permission. It
can only watch modifier, function, lock and media keys. On Linux it needs an X11 session (on Wayland the
key works while Grok Bot is focused), and music ducking needs `pactl` 16 or newer.

### Voice MCP servers

#### Built-in BGB Sidebar Folders

Setup registers **BGB Sidebar Folders** disabled if absent; it preserves existing enabled choices and never overwrites a user server with the same ID. No command arguments or configuration are needed for this preset, and the compiled BGB binary needs no external runtime.

1. Manually open the updated app, then ensure the **Sidebar Folders** and **Voice MCP** plugins are enabled.
2. Enable **BGB Sidebar Folders** in **Settings → General → System → Voice MCP servers**.
3. Start a new voice conversation. These tools never automatically launch the app or agent.
4. Say “Create a folder called Work,” “Move Cook into Work,” or “Delete Work.” Deleting a folder preserves every bot; bots outside all remaining folders become **Unassigned**. There is no bot-delete tool.

| Tool | Action |
|---|---|
| `bgb_list_bots` | Discover bot IDs, names and folder membership |
| `bgb_list_folders` | Discover folder IDs and names |
| `bgb_move_bot` | Move a bot to a folder; `folder: null` moves it to Unassigned |
| `bgb_create_folder` | Create a named folder |
| `bgb_delete_folder` | Delete only the container; the default `__agents__` section is protected |

Selectors accept IDs or unique normalized exact names, never fuzzy matches. Duplicate names fail with candidates rather than choosing a bot or folder arbitrarily. The app and agent must already be running, with the updated sidebar runtime, a fresh roster and confirmed storage ready for actions. Voice calls target their originating window; a direct external MCP client without window context requires exactly one capable window and fails on multi-window ambiguity.

Actions use the app's native sections with BGB's fallback and await the owned native operation or storage write. A failure, timeout or client reset can leave an **unknown outcome**: inspect current state before retrying. Tools never automatically replay actions. The preset communicates only with the local bridge, but selected bot/folder results still reach the remote voice model.

#### Other servers

Open **Settings → General → System → Voice MCP servers**, then **Add** a named server:

- **stdio:** enter its command, arguments as a JSON array, environment variables as a JSON object, and an optional working directory. Install the command's local runtime first; use an absolute executable path if BGB's agent PATH cannot find it.
- **Streamable HTTP** or **legacy SSE:** enter the server URL and headers as a JSON object. Authentication uses explicit headers (for example, `Authorization`); OAuth is not supported.

Save leaves a new server **disabled**. **Test connection** works without enabling it: it may start the local command or contact the server and discover tools, but does not execute tools. Explicitly enable the server, then manually rejoin or start a voice call to use its tools. Normal text chat is unchanged.

Enabling a server trusts its tools to act as you **without per-call prompts**. The voice model receives tool schemas and results; voice processing is still remote. Full configurations, including environment variables and authentication headers, are shared by the host in `DATA/mcp.json` with mode `0600`; they are **not encrypted**.

## Community plugins

Install a plugin from a `.bgbplugin` file, a folder, an `https://` link or a GitHub release
(`github:owner/repo`), in Settings or with `bgb plugins install`. Before installing, BGB shows what the
plugin asks for:

| Permission | Meaning |
|---|---|
| `keys` | Listen to a key while Grok Bot is in the background |
| `media` | Lower other apps' volume |
| `mcp` | Manage MCP servers, start configured commands or contact servers, and use enabled servers' tools |

Writing plugins: [docs/plugins.md](docs/plugins.md). Themes: [docs/themes.md](docs/themes.md).

## Themes

A theme is a CSS file named `<id>.theme.css` that starts with a header:

```css
/**
 * @name Midnight
 * @description Darker panels
 * @author you
 * @version 1.0.0
 */
```

Install it with `bgb themes install <file|url>` (or drop it into `DATA/themes`) and turn it on in Settings.
Theme changes apply to open windows without a reload.

## Updates

- **BGB** checks GitHub Releases every few hours and installs new versions automatically (turn this off in
  Settings). A new version must pass a self-test and start successfully, or BGB restores the previous one.
- **Grok Bot updates** are detected automatically; BGB rebuilds for the new version. If a plugin's patches no
  longer fit, that plugin is turned off for that version, you get a notification, and Settings shows it.

## Uninstall

```sh
bgb uninstall          # keep your plugins, themes and settings
bgb uninstall --purge  # delete everything
```

Then quit and reopen Grok Bot; it starts without Better Grok Bot.

## Safety

Better Grok Bot is a trusted-plugin system. **Install only plugins you trust.**

- Plugins run inside Grok Bot with your account and can read anything it shows, including what you type
  there.
- Permissions are consent prompts, not a sandbox: plugins share one JavaScript realm and can read the
  page's agent bridge token. MCP checks grants by `pluginId`, but a malicious plugin can impersonate a
  granted ID.
- Background key watching is limited to modifier, function, lock and media keys; BGB's key service does
  not stream system-wide typing. MCP deliberately allows configured host commands to run with your user
  rights, and enabled tools can perform actions locally or remotely without per-call prompts.
- `bgb plugin build` and `bgb dev` run plugin source code on your computer with your user rights.
- The global `VITE_DEV_SERVER_URL` variable on macOS and Windows (see above).

## Troubleshooting

- `bgb doctor` checks the install and tells you what to fix.
- `bgb logs` shows what the agent did; `bgb logs -f` follows it.
- Settings says the background agent isn't running: run `bgb start`.
- Grok Bot opened without BGB: run `bgb restart`.

Bug reports: please include `bgb doctor` output.

## Development

```sh
bun install
bun run typecheck
bun test
bun run bgb -- check --asar "/Applications/Grok Bot.app/Contents/Resources/app.asar"
bun run dev:install   # build the binary and install it on this machine
```

See [AGENTS.md](AGENTS.md) for the codebase rules and [docs/releasing.md](docs/releasing.md) for releases.

## License

MIT © 2026 Hayden Evan. See [LICENSE](LICENSE).

Not affiliated with or endorsed by xAI, SpaceXAI, Cursor or Anysphere. Grok is a trademark of its owner.
Better Grok Bot never ships Grok Bot code; each install patches the user's own copy.

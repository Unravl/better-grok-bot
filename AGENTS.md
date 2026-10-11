# Agent guide: Better Grok Bot

Better Grok Bot (BGB) is a plugin/theme/hook framework for the Grok Bot Electron app
(`com.anysphere.sand`) on macOS, Windows and Linux. It ships as one compiled Bun binary, `bgb`
(CLI + background agent). BGB patches a private copy of the app's renderer (web UI) and makes
the real, signed app load it through `VITE_DEV_SERVER_URL`. `sdk/` is the contract every part
codes against; read it first.

## Layout

|Path|Purpose|
|---|---|
|`sdk/`|Browser-safe shared contract (types, constants, pure helpers). Change only additively. No `node:*`, `bun:*` or `Bun.*`.|
|`core/`|Host code: CLI (`core/cli.ts`), agent, bridge, build engine, platform adapters, setup, services, self-update.|
|`core/hooks/`|Core hook plugins `bgb-react`, `bgb-settings`, `bgb-client`.|
|`loader/`|Renderer runtime `globalThis.BetterGrokBot` (bundled to an IIFE into `assets/bgb/boot.js`).|
|`plugins/<id>/`|Bundled plugins (`plugin.ts` + `runtime.ts`, optional `styles.css`). `id` equals the folder name.|
|`native/`|Native helpers: `macos-helper/` (Swift), `helper/` and `bgbw/` (Rust).|
|`scripts/`|Build, release, canary, e2e and maintenance scripts.|
|`.github/workflows/`|CI, release, helper release, canary.|

## Hard rules

- NEVER modify anything inside the Grok Bot install (`/Applications/Grok Bot.app`, `%LOCALAPPDATA%\Programs\…`,
  `/opt/Grok Bot`, AppImages). Its asar is integrity-checked; only a private renderer copy is moddable.
- NEVER commit or share app code (extracted or patched renderer files). Share plugin source only.
- Patches anchor on text the minifier keeps: string literals, property names, browser API names.
  Match minified identifiers with `\i` (expands to `[\w$]+`) and backreferences, never literally.
- Every patch has an exact `expect` (default 1). If any patch of a plugin misses, the whole plugin
  is dropped for that build (`patch-failed`).
- Patched code reaches plugins only through the guard pattern, with the original expression as the
  fallback: `x=globalThis.BetterGrokBot?.call("<id>","fn",args)??originalExpr`.
- UI goes through `BetterGrokBot.component` with the app's React/`jsx`; the loader wraps it in an
  error boundary.
- Community plugins: string replacements only (no `` $` `` / `$'`), patches run in a worker under time
  and size limits, may not touch `index.html` or `assets/bgb/`. Function replacers are allowed only
  for core hooks and bundled plugins.
- Code style: TypeScript strict, no `any`, tabs, Bun APIs (`Bun.file`, `Bun.write`, `Bun.$`). No
  module-level path constants in `core/`; take `ctx: CoreContext`.

## Verify

1. `bun run typecheck`
2. `bun test`
3. `bun run bgb -- check --asar "/Applications/Grok Bot.app/Contents/Resources/app.asar"` → `ok: true`.
4. Live: `bun run dev:install`, then `open -a "Grok Bot" --args --remote-debugging-port=9333` and over
   CDP (`http://127.0.0.1:9333/json/list` → `page` target) evaluate `BetterGrokBot.status()` and
   `BetterGrokBot.bridgeState()`. Console lines are prefixed `[bgb]` / `[bgb:<id>]`.

Grok Bot is the user's real, logged-in app with a single-instance lock. Don't start voice calls,
send messages, or change unrelated settings without asking.

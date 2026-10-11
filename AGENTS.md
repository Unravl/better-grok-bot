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
|`core/hooks/`|Core hook plugins `bgb-react`, `bgb-settings`, `bgb-client`, `bgb-brand`.|
|`loader/`|Renderer runtime `globalThis.BetterGrokBot` (bundled to an IIFE into `assets/bgb/boot.js`).|
|`plugins/<id>/`|Bundled plugins (`plugin.ts` + `runtime.ts`, optional `styles.css`). `id` equals the folder name.|
|`native/`|Native helpers: `macos-helper/` (Swift), `helper/` and `bgbw/` (Rust).|
|`scripts/`|Build, release, canary, e2e and maintenance scripts.|
|`.github/workflows/`|CI, release, helper release, canary.|

## Hard rules

- NEVER modify anything inside the Grok Bot install (`/Applications/Grok Bot.app`, `%LOCALAPPDATA%\Programs\…`,
  `/opt/Grok Bot`, AppImages). Its asar is integrity-checked; only a private renderer copy is moddable.
- NEVER quit, exit, stop, kill, restart, or relaunch an existing Grok Bot instance. The user
  handles its lifecycle manually. This includes commands, scripts, helpers, and automation
  that would stop or restart it indirectly.
- NEVER perform computer use or live/in-app feature verification, including browser/UI
  automation or CDP checks. The user verifies feature correctness manually; do not interact
  with the running app to validate implementations or perform smoke checks.
- Every change the user asks for MUST also be installed into the user's own BGB, not just made in the
  repo, so the next time they open Grok Bot it has the update. After the Verify checks pass, run
  `bun run build:binary && ./dist/bgb setup --yes --no-restart`: it replaces the installed `bgb` and
  rebuilds the renderer without touching a running Grok Bot (never plain `bun run dev:install`, which
  restarts it). Confirm with `bgb status` (new last build, no failed plugins).
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
4. Live feature verification is user-only and manual. Leave app lifecycle actions and in-app
   correctness checks to the user; report automated check results without attempting live verification.
5. Install it into the user's BGB (see Hard rules): `bun run build:binary && ./dist/bgb setup --yes --no-restart`,
   then `bgb status`.

Grok Bot is the user's real, logged-in app with a single-instance lock. Don't start voice calls,
send messages, or change unrelated settings without asking.

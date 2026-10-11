# Releasing Better Grok Bot

Three kinds of release flow through GitHub Actions:

|Release|Tag|Workflow|Result|
|---|---|---|---|
|Native helpers|`helper-vN`|`.github/workflows/helpers.yml`|Pre-release with the five helper binaries, `SHA256SUMS` and `helper-manifest.json`|
|App (`bgb`)|`vX.Y.Z`|`.github/workflows/release.yml`|Release with six `bgb` archives and `SHA256SUMS`; `install.sh`/`install.ps1` and self-update read it|
|Upstream canary|none (every 3 h)|`.github/workflows/canary.yml`|`upstream.json` on branch `canary-state`; `upstream-break` issues|

## 1. Helper release (before the first app release, and whenever `native/` changes)

The helpers change rarely on purpose: macOS keeps Input Monitoring and Automation permissions only
while the helper's bytes stay the same, so a BGB update reinstalls a helper only when
`native/helper-manifest.json` names a new helper version.

1. Merge the `native/` changes to `main` (CI runs `rust` and `swift`).
2. Pick the next number `N` (one more than `version` in `native/helper-manifest.json`), then:

   ```sh
   git tag helper-vN && git push origin helper-vN
   ```

3. Watch `helpers.yml`. It builds the macOS universal app (`macos-15`), the Windows helpers
   (`windows-2025`, `windows-11-arm`) and the Linux helpers (`ubuntu-24.04`, `ubuntu-24.04-arm`),
   signs them when the signing secrets exist, and publishes a **pre-release** (never "latest").
4. Pin it locally and open a normal PR, so CI runs on the new manifest:

   ```sh
   bun scripts/update-helper-manifest.ts helper-vN
   git switch -c helper-vN && git commit -am "chore: pin native helpers helper-vN" && git push -u origin helper-vN
   ```

   The script downloads the release's `helper-manifest.json` and `SHA256SUMS`, checks that all five
   assets are present and that every hash agrees, and writes `native/helper-manifest.json`.

## 2. App release

1. Make sure `CHANGELOG.md` `## [Unreleased]` describes the release and `native/helper-manifest.json`
   pins all five helpers (`release.yml` refuses to run otherwise).
2. Bump and tag:

   ```sh
   bun scripts/bump-version.ts X.Y.Z   # package.json + CHANGELOG.md + README release badge
   git commit -am "chore: release X.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

3. Watch `release.yml`:
   - `verify`: the tag equals `package.json`'s version, `scripts/extract-changelog.ts` finds the
     section, and the helper manifest is complete.
   - `build` (six runners): `scripts/build-binaries.ts compile`, signing when secrets exist,
     `scripts/smoke-compiled.ts` (the darwin-x64 binary runs under Rosetta, skipped without it),
     `scripts/build-binaries.ts archive`, build provenance attestation.
   - `e2e` (macOS arm64, Windows x64, Linux x64): installs the latest Grok Bot from the public feed and
     runs `scripts/e2e.ts` against the archive built above.
   - `publish`: `gh release create vX.Y.Z` with the archives, the combined `SHA256SUMS` and the
     changelog section as notes. The bytes published are the bytes that were tested.
4. Run the manual checklist below and update the README "Verified on" table.

### Signing secrets (optional)

Without them every artifact ships unsigned (macOS binaries carry an ad-hoc signature).

|Platform|Secrets|Effect|
|---|---|---|
|macOS|`APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`|Developer ID signature with hardened runtime + notarization (`packaging/macos/entitlements.plist` for `bgb`; the helper app is also stapled)|
|Windows|`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE`|Azure Trusted Signing of `bgb.exe`, `bgbw.exe` and the helper `.exe`s|

All six secrets of a platform must exist; otherwise that platform's signing steps are skipped.

### If a release fails

- `verify` or `build` failed: nothing was published. Fix on `main`, delete the tag
  (`git push --delete origin vX.Y.Z && git tag -d vX.Y.Z`), tag again.
- `e2e` failed: nothing was published. Download the `e2e-<platform>` artifact for the failing checks.
- `publish` failed after creating the release: delete the release and tag in GitHub, then re-tag.

## Manual release checklist

CI cannot cover a real login, a logged-in Grok Bot, the Settings UI or real keyboards and speakers.
Before announcing a release, check on real machines:

**macOS (Apple silicon; Intel when available)**

1. `curl -fsSL https://raw.githubusercontent.com/Unravl/better-grok-bot/main/install.sh | sh` on a Mac
   with Grok Bot running: setup asks to restart Grok Bot and it comes back modded.
2. Settings → General shows the Better Grok Bot section: status "Connected", the four bundled plugins
   with toggles; toggling one rebuilds and offers "Reload to apply".
3. Push to talk: "Install key helper", allow it in System Settings → Privacy & Security → Input
   Monitoring; holding the key in the background talks in a manual-turn call; Spotify ducks and restores.
4. Log out and back in: the agent starts, Grok Bot launches modded from the Dock and Spotlight;
   with "Open Grok Bot at login" on, it opens by itself.
5. A grok-mods install, if you still have one, is migrated (old LaunchAgents moved to
   `DATA/migrated/grok-mods/`).

**Windows 11 (x64; arm64 when available)**

1. `irm https://raw.githubusercontent.com/Unravl/better-grok-bot/main/install.ps1 | iex`.
2. Start Grok Bot from the Start menu and from a pinned taskbar icon: both load modded.
3. Push to talk in the background with a modifier or function key; Spotify ducks and restores.
4. Sign out and in: the agent starts without a console window flashing.

**Linux (Ubuntu 24.04 X11 deb; Fedora rpm or an AppImage when available)**

1. `install.sh`, then launch Grok Bot from the desktop's app menu: it loads modded.
2. X11: the background key works. Wayland: the Settings row says the key works only while Grok Bot
   is focused.
3. Spotify ducks through `pactl`.

**Every OS**

1. `bgb doctor` is all ✓; `bgb update --check` reports the new version as current.
2. Self-update from the previous release: an agent on the previous version updates within 6 h (or at
   once with `bgb update`), and `bgb status` shows the new version.
3. `bgb uninstall --purge`, then quit and reopen Grok Bot: it starts unmodded.

Record each passing OS/version pair in the README "Verified on" table
(`| OS | Arch | Grok Bot | BGB | Date |`).

## Upstream canary

`canary.yml` runs every 3 hours (and on demand from the Actions tab, with `force` to re-test
everything). `scripts/canary.ts detect` reads the public feed for all six platforms and selects
entries that are new, or that failed and were not yet re-tested with the current `main` commit.
For each it runs `bgb check` against the extracted app (`compat`), and for macOS arm64, Windows x64
and Linux x64 also the full `scripts/e2e.ts`. `scripts/canary.ts report` then:

- records `pass`/`fail`/`error` per `<feedPlatform>@<version>+<commitSha>` in `upstream.json` on the
  `canary-state` branch (`error` = a job crashed or was cancelled);
- opens or comments on the issue `Grok Bot <version> breaks Better Grok Bot` (label `upstream-break`)
  with a table of failing checks and patch ids, only when that table changed;
- closes the issue once every platform of that version passes.

Maintenance:

- Keep `canary-state` **unprotected**: the workflow pushes to it with `GITHUB_TOKEN`.
- GitHub disables scheduled workflows after 60 days without repository activity. When the warning
  email arrives, re-enable `canary.yml` from the Actions tab.
- The canary only ever reports check names, plugin and patch ids and match counts — never app code.

## Local tools

|Script|Purpose|
|---|---|
|`bun scripts/build-binaries.ts compile --host --out dist`|Compile `bgb` for this machine (`bun run build:binary`)|
|`bun scripts/smoke-compiled.ts --bin dist/bgb`|Smoke-test a compiled binary away from the checkout|
|`bun scripts/fetch-upstream.ts --platform linux-x64 --format deb --extract /tmp/grok`|Download and extract an upstream Grok Bot release; `--print-version`/`--print-json` read the feed only|
|`bun scripts/extract-changelog.ts X.Y.Z`|Print a changelog section|

`fetch-upstream.ts --install` and `scripts/e2e.ts` replace or drive the machine's Grok Bot and
install Better Grok Bot in the default data directory; both refuse to run outside GitHub Actions.

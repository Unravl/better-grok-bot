# Changelog

All notable changes to Better Grok Bot are documented here.

## [Unreleased]

### Fixed

- Windows: `bgbw.exe` starts `bgb.exe` without inheriting handles, so the agent that the login Run value starts no longer keeps the launching program's output pipe open (a script capturing it waited forever).
- Windows: setup creates the `HKCU\…\CurrentVersion\Run` key when it is missing instead of failing.

## [0.1.0] - 2026-10-11

### Added

- Initial release: `bgb` CLI and background agent, plugin/theme system, bundled plugins (output-device, push-to-talk, startup, voice-keepalive), native key/media helpers, self-update.

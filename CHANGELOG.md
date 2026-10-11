# Changelog

All notable changes to Better Grok Bot are documented here.

## [Unreleased]

### Fixed

- Windows: `bgbw.exe` starts `bgb.exe` without inheriting handles, so the agent that the login Run value starts no longer keeps the launching program's output pipe open (a script capturing it waited forever).
- Windows: setup creates the `HKCU\…\CurrentVersion\Run` key when it is missing instead of failing.
- Self-update is single-flight: concurrent `update.apply` requests (or the automatic check) join one install, and every change to `DATA/bin` runs under a `binaries` lock, so a second transaction can no longer discard the first one's `bin/previous/` rollback copy (it gets `conflict`).
- A community or dev plugin reusing a bundled or taken id no longer blocks the real plugin's runtime in Grok Bot; the invalid duplicate is still listed.
- Lock and agent-record reclamation runs under a `<lock>.reclaim` mutex and deletes only the exact stale record it judged, so a live holder's lock is never moved aside or shared.
- Process identity is verified exactly (Linux start ticks, macOS start second, Windows `GetProcessTimes` creation time); a record that can't be verified never counts as alive and is never signaled. On Windows, an agent started by 0.1.0 is not recognized by the new CLI: if one is running when you reinstall, stop it first with the old `bgb stop`.

## [0.1.0] - 2026-10-11

### Added

- Initial release: `bgb` CLI and background agent, plugin/theme system, bundled plugins (output-device, push-to-talk, startup, voice-keepalive), native key/media helpers, self-update.

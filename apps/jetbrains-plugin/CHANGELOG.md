# Changelog

All notable changes to the CodeAgent-Mobile JetBrains plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.9.7] — 2026-05-10

### Fixed

- **cli:** Lazy-detect conversation id in uploadDelta when eager-detect missed it

### Revert

- **cli:** Drop tryDetectApiError side-channel — broke code-block rendering

## [2.9.6] — 2026-05-10

### Revert

- **cli:** Drop tryDetectApiError side-channel — broke code-block rendering

## [2.9.5] — 2026-05-10

### Fixed

- **cli:** Preserve newlines when scanning PTY for API errors

## [2.9.4] — 2026-05-10

### Fixed

- **cli:** Feed accumulated PTY buffer to API-error detector

## [2.9.3] — 2026-05-10

### Fixed

- **cli:** Surface Anthropic API errors as status chunks

## [2.9.2] — 2026-05-09

### Fixed

- **jetbrains-plugin:** Heuristic table detection for AI Assistant Compose chat
- **jetbrains-plugin:** Broaden Compose-table heuristic + diagnostic log

## [2.9.1] — 2026-05-09

### Fixed

- **jetbrains-plugin:** Heuristic table detection for AI Assistant Compose chat

## [2.9.0] — 2026-05-09

### Added

- **jetbrains-plugin:** Per-agent MessageExtractor strategy + Copilot/AI Assistant capture

## [2.8.1] — 2026-05-09

### Revert

- **jetbrains-plugin:** Drop CLI plugin-bridge from ClaudeCodeTerminalStrategy

## [2.8.0] — 2026-05-09

### Added

- **cli:** Plugin-bridge subcommand for one-session IDE embedding
- **jetbrains-plugin:** Per-agent Strategy pattern + AI Assistant capture + CLI bridge

## [2.7.0] — 2026-05-08

### Added

- **cli:** Codeam pair-auto subcommand for in-codespace auto-pairing

## [2.6.0] — 2026-05-08

### Added

- **vsc-plugin:** Replay X-Plugin-Auth-Token + delta conversation upload
- **jetbrains-plugin:** Full parity with CLI — auth token, missing handlers, chunk emissions

### CI

- **release:** Make verifyPlugin non-fatal so JetBrains release ships

### Chore

- **cli:** Bump source version to 2.6.0 for unified release line

### Fixed

- **shared:** Selector detector locks onto trust-dialog text without a cursor

## [2.5.4] — 2026-05-07

### Fixed

- **shared:** Selector detector accepts both ❯ and > as cursor glyph

## [2.4.39] — 2026-05-06

### Added

- **cli:** Per-turn delta upload to keep canonical conversation fresh

## [2.4.37] — 2026-05-06

### Fixed

- **shared:** Filter multi-column TUI box chrome (welcome banner)

## [2.4.36] — 2026-05-06

### Fixed

- **shared:** Keep Claude reply when it lands right after the user echo

## [2.4.35] — 2026-05-06

### Added

- **cli:** Dump rendered lines when filterChrome returns empty

## [2.4.33] — 2026-05-05

### Fixed

- **cli:** Match local terminal size + forward resize on Windows ConPTY (v2.4.33)

## [2.4.32] — 2026-05-05

### Fixed

- **cli:** Resolve Claude through cmd.exe on Windows when it's a .cmd shim (v2.4.32)

## [2.4.31] — 2026-05-05

### Fixed

- **cli:** Vendor node-pty into dist/ — guarantees ConPTY binary on Windows (v2.4.31)

## [2.4.30] — 2026-05-05

### Fixed

- **cli:** Pin node-pty ^1.1.0 + graceful pipe fallback if ConPTY fails (v2.4.30)

## [2.4.29] — 2026-05-05

### Added

- **cli:** Auto-install Claude Code if missing on first launch (v2.4.29)

## [2.4.28] — 2026-05-05

### Fixed

- **cli:** Give Claude Code a real PTY on Windows via ConPTY (v2.4.28)

## [2.4.27] — 2026-05-04

### Fixed

- **cli:** Always show machine picker, even with one option (v2.4.27)

## [2.4.26] — 2026-05-03

### Fixed

- **cli:** Set_keep_alive PATCHes idle_timeout instead of pinging API (v2.4.26)

## [2.4.25] — 2026-05-03

### Added

- **cli:** Three new deploy providers — Gitpod, GitLab Workspaces, Railway (v2.4.25)

## [2.4.24] — 2026-05-03

### Added

- **cli:** List repos from user's orgs after expand-scopes (v2.4.24)

## [2.4.23] — 2026-05-03

### Fixed

- **cli:** Shutdown_session also runs gh codespace stop (v2.4.23)

## [2.4.22] — 2026-05-03

### Added

- **cli:** "+ Don't see your project?" expands gh OAuth scopes (v2.4.22)

## [2.4.21] — 2026-05-03

### Fixed

- **cli:** Only run keep-alive heartbeat inside a Codespace (v2.4.21)

## [2.4.20] — 2026-05-03

### Added

- **cli:** Handle set_keep_alive command from apps' Settings modal (v2.4.20)

## [2.4.19] — 2026-05-03

### Added

- **cli:** Handle shutdown_session command from mobile / web (v2.4.19)

## [2.4.18] — 2026-05-03

### Added

- **cli:** Codeam deploy ls + stop, plus runtime tag for the apps (v2.4.18)

## [2.4.17] — 2026-05-03

### Fixed

- **cli:** Show the QR in codeam deploy (tail -n +1) (v2.4.17)

## [2.4.16] — 2026-05-03

### Fixed

- **cli:** Clean codeam deploy log output under PM2 (v2.4.16)

## [2.4.15] — 2026-05-03

### Fixed

- **cli:** Robust pm2 wrapper for codeam deploy (v2.4.15)

## [2.4.14] — 2026-05-03

### Fixed

- **cli:** Use PM2 to keep codeam-pair alive on Codespaces (v2.4.14)

## [2.4.13] — 2026-05-03

### Fixed

- **cli:** Codeam pair survives SSH disconnect for codeam deploy (v2.4.13)

## [2.4.12] — 2026-05-03

### Fixed

- **cli:** Wait for Claude to be ready before closing local terminal (v2.4.12)

## [2.4.11] — 2026-05-03

### Fixed

- **cli:** Codeam deploy detaches local terminal after pairing (v2.4.11)

## [2.4.10] — 2026-05-03

### Fixed

- **cli:** Ship ~/.claude.json so codespace skips onboarding (v2.4.10)

## [2.4.9] — 2026-05-03

### Added

- **cli:** Ask before bridging local Claude credentials (v2.4.9)

## [2.4.8] — 2026-05-03

### Fixed

- **cli:** Never let Claude show first-launch login on a codeam deploy (v2.4.8)

## [2.4.7] — 2026-05-03

### Fixed

- **cli:** Cross-platform Claude credential bridge for codeam deploy (v2.4.7)

## [2.4.5] — 2026-05-03

### Fixed

- **cli:** Clearer guidance when gh refresh hits multi-account browser (v2.4.5)

## [2.4.4] — 2026-05-03

### Fixed

- **cli:** Unblock interactive gh prompts inside codeam deploy (v2.4.4)

## [2.4.3] — 2026-05-03

### Fixed

- **cli:** Refresh missing `codespace` scope on existing gh logins (v2.4.3)

## [2.4.2] — 2026-05-03

### Fixed

- **cli:** Codespace machine picker + auto-install gh; deploy doc (v2.4.2)

## [2.4.1] — 2026-05-03

### Added

- **cli:** Interactive `claude login` fallback when no local config (v2.4.1)

## [2.4.0] — 2026-05-03

### Added

- **cli:** `codeam deploy` — provision a paired cloud workspace in one command (v2.4.0)

## [2.2.2] — 2026-05-02

### Fixed

- **clients:** Recursive suffix search for read_file (v2.2.2)

## [2.2.1] — 2026-05-02

### Fixed

- **cli:** Subdir fallback for read_file when CLI cwd is a monorepo parent (v2.2.1)

## [2.1.0] — 2026-04-25

### Added

- **cli:** Exponential polling backoff with ±10% jitter
- **cli:** Forward X-Plugin-Auth-Token on /commands/output

### Build

- **deps:** Bump com.google.zxing:core in /apps/jetbrains-plugin (#5)
- **deps:** Bump org.jetbrains.intellij.platform (#6)
- **deps:** Bump gradle-wrapper in /apps/jetbrains-plugin (#14)

### CI

- **jetbrains:** Publish plugin to Marketplace stable channel on tag

### Changed

- **cli:** Drop unused token field from WS auth payload
- **cli:** Zod-validate remote command payloads

### Chore

- Ignore .worktrees directory
- **cli:** Upgrade @clack/prompts to 1.2.0 (ESM bundled via tsup)
- **deps:** Bump vitest to clear esbuild CVE (GHSA-67mh-4wv8-2f99)

### Documentation

- Enforce correct-and-implicit TypeScript typing

### Fixed

- **cli:** Pass PTY args as argv array (no shell concatenation)
- **cli:** Clean up PTY child on SIGINT/SIGTERM
- **vsc-plugin:** Guard startMonitoring against re-entry; scaffold vitest

## [2.0.2] — 2026-04-23

### Build

- **deps:** Bump actions/setup-node from 4 to 6 (#2)
- **deps:** Bump actions/checkout from 4 to 6 (#1)
- **deps:** Bump actions/setup-java from 4 to 5 (#3)

### Changed

- **workflow:** Commit CHANGELOG updates directly to main, drop PR step (#17)

### Fixed

- **workflow:** Grant pull-requests write to release job so changelog PR opens (#16)

## [2.0.1] — 2026-04-23

### Added

- **workflow:** Auto-generate per-release changelog from conventional commits

### Chore

- Post-2.0 polish — Q1 Q2 Q3 Q5 + PR-based changelog commit-back (#15)

## [2.0.0] — 2026-04-23

### Added
- Plugin icon on the JetBrains Marketplace listing — the same `</>`-in-rounded-square mark that ships with the CodeAgent Mobile mobile app.

### Changed
- **Version alignment** — all three CodeAgent Mobile clients now share a single version line starting at `2.0.0`. Going forward, a single `vX.Y.Z` git tag releases all of them together (the JetBrains plugin is uploaded manually for now while signing configuration is finalized).

## [1.0.7] — 2026-04-13

### Added
- Terminal-based agent handling: the plugin now drives the built-in IntelliJ terminal to send prompts, monitor output, and relay interactive confirmations to the mobile app.
- Session management improvements: pluginId forwarded in terminal output, stricter session validation.

## [1.0.5] — 2026-03-20

### Added
- Multi-IDE support: compatibility extended across the IntelliJ family (IDEA, WebStorm, PyCharm, Rider, GoLand, etc.).
- Enhanced pairing and session management.

## [1.0.3] — 2026-03-16

### Fixed
- Cascade prompt dispatch now uses JCEF JavaScript injection instead of Robot paste — avoids focus-stealing and fixes intermittent "nothing happened" after sending a prompt.

## [1.0.1] — 2026-03-15

### Changed
- Extended IDE compatibility to build `261.*`, adding support for WebStorm 2025.3+.

## [1.0.0] — 2026-03-14

### Added
- Initial release. Secure device pairing via 6-digit code, real-time agent status, WebSocket-based live communication, MCP server configuration, and a dedicated tool window in the IDE.
- Claude Code terminal support — detect, send prompts, and monitor output.

---

Published releases live on the [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/30697-codeagent-mobile).

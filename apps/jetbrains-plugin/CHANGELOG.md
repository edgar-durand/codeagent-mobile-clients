# Changelog

All notable changes to the CodeAgent-Mobile JetBrains plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

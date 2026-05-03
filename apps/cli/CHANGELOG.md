# Changelog

All notable changes to `codeam-cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Changed
- **Version alignment** — all three CodeAgent Mobile clients (`codeam-cli`, the VS Code extension, and the JetBrains plugin) now share a single version line starting at `2.0.0`. Going forward, a single `vX.Y.Z` git tag releases all of them together via the automated pipeline.
- First release built from the public source repository at [`edgar-durand/codeagent-mobile-clients`](https://github.com/edgar-durand/codeagent-mobile-clients).

## [1.4.58] — 2026-04-23

### Changed
- First release published from the public source repository at [`edgar-durand/codeagent-mobile-clients`](https://github.com/edgar-durand/codeagent-mobile-clients). No functional changes — only the `repository` and `bugs` URLs in `package.json` now point to the public repo.

## [1.4.57] — 2026-04-22

### Added
- Dynamic model list — `list_models` now returns the actual set of Claude models loaded by the running agent instead of a hardcoded array.

## [1.4.55] — 2026-04-21

### Changed
- README now links to the official Claude Code quickstart.
- SEO / npm discoverability pass (keywords, description).

## [1.4.54] — 2026-04-20

### Fixed
- Retry critical output chunks up to 3× on transient network errors.
- Silence `ECONNRESET` / socket hang-ups so they no longer corrupt Claude's TUI output stream.

## [1.4.50] — 2026-04-19

### Fixed
- Robust spinner-line deduplication via ellipsis strip — handles every spinner/status format the TUI produces.
- Ignore user-typed input echoed back through the PTY when deduplicating chrome steps.
- Smart auto-scroll and live context-ring percentage.

## [1.4.46] — 2026-04-17

### Added
- Thinking-UI `chrome_steps` support — detect bullet / tree / status lines from the new Claude Code TUI format and forward them as step events to the mobile app.

### Fixed
- Deduplicate chrome steps per turn — the CLI accumulates unique history while clients replace per-turn snapshots, so mobile no longer shows repeated lines.
- API forwards the `steps` field in output chunks (previously silently dropped).

## [1.4.38] — 2026-04-14

### Added
- Sync terminal-typed prompts back to the mobile app in real time.
- Load the current Claude conversation on session entry via a new `get_conversation` command.

### Fixed
- Prompt submission after pairing — first keystroke no longer lost.
- Keyboard dismiss and output-noise cleanup.
- Re-push conversation to the API after every Claude turn so auto-load always finds a fresh snapshot.

---

For versions prior to 1.4.38, consult the [npm release page](https://www.npmjs.com/package/codeam-cli?activeTab=versions).

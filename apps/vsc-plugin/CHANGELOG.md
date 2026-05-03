# Changelog

All notable changes to the CodeAgent Mobile VS Code extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Product icon on the Marketplace listing — the same `</>`-in-rounded-square mark that ships with the CodeAgent Mobile mobile app.

### Changed
- **Version alignment** — all three CodeAgent Mobile clients now share a single version line starting at `2.0.0`. Going forward, a single `vX.Y.Z` git tag releases all of them together via the automated pipeline.

## [1.4.21] — 2026-04-23

### Changed
- First release published from the public source repository at [`edgar-durand/codeagent-mobile-clients`](https://github.com/edgar-durand/codeagent-mobile-clients). No functional changes — only the `repository` URL in `package.json` now points to the public repo.

## [1.4.20] — 2026-04-22

### Added
- Agent-aware context — when the Claude agent is selected, `list_models` returns the Claude model set and `get_context` returns a CLI-shaped weekly-quota / token-usage snapshot (rate-limit reset, quota %, monthly cost). Copilot keeps its previous behavior.

## [1.4.19] — 2026-04-21

### Fixed
- First prompt after pairing no longer gets dropped — the extension now polls the Claude TUI for the `? for shortcuts` readiness marker before submitting.
- Orphan "Claude Code" terminals from older releases are disposed on activation, preventing the duplicate-terminal state that happened on auto-update.
- Claude welcome logo rendered as scattered blocks on mobile — PTY width is now pinned to ≤ 100 cols and box-drawing chrome is stripped so the logo appears correctly in the phone UI.

## [1.4.18] — 2026-04-21

### Fixed
- Replaced fixed-delay idle detection with a `? for shortcuts` poll — prevents the first prompt from being lost in a render pause before Ink mounts its input widget.

## [1.4.17] — 2026-04-20

### Added
- The extension spawns its own Claude Code PTY (`node-pty`) and exposes it as a VS Code `Pseudoterminal`, streaming output to mobile in real time and forwarding interactive `select_prompt` / `select_option` events — parity with the CLI.

## [1.4.16] — 2026-04-19

### Changed
- Chunk protocol now mirrors `codeam-cli` exactly for both the VS Code Chat relay and the Claude Code terminal, so mobile rendering is identical regardless of which agent the user picked.

### Fixed
- Stream full accumulated text per chunk instead of deltas — fixes out-of-order rendering on mobile.

## [1.4.15] — 2026-04-18

### Added
- Track VS Code Chat conversation history so mobile can reload past turns after reconnect.

## [1.4.14] — 2026-04-17

### Added
- Dynamic model list — drop hardcoded model constants; the plugin / CLI now reports the actual models available to the current agent.

## [1.4.13] — 2026-04-16

### Added
- Report model, context size, and token counts back to the mobile app for every turn.

## [1.4.12] — 2026-04-15

### Fixed
- Detect any language-model provider (not just Copilot) via `vscode.lm` on VS Code 1.90+.
- Register VS Code Chat unconditionally on VS Code 1.90+.
- Detect Copilot by extension ID first and fall back to an LM call with a timeout.

## [1.4.3] — 2026-04-13

### Added
- CLI feature parity for the VS Code and JetBrains plugins.

---

For versions prior to 1.4.3, see the [Marketplace version history](https://marketplace.visualstudio.com/items/CodeAgentMobile.codeagent-mobile/changelog).

# Changelog

All notable changes to the CodeAgent Mobile VS Code extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

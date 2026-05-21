# Changelog

All notable changes to `codeam-cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.15.8] — 2026-05-21

### Fixed

- **cli:** Pairing-box alignment + countdown actually ticks (#39)

## [2.15.7] — 2026-05-21

### Fixed

- **clients:** Point default API URL at api.codeagent-mobile.com + centralize via shared constant (#38)

## [2.15.6] — 2026-05-20

### Added

- **cli:** Send current git branch on pair
- **vsc-plugin:** Emit file-change + review-hunk events from Path B (direct claude)
- **jetbrains-plugin:** Emit file-change + review-hunk events from Path B
- **cli:** Epic C — emit streaming chunks + subscribe to answer channel

## [2.15.5] — 2026-05-20

### Added

- **shared:** Add FileChangedEvent + PendingReviewHunkEvent wire types
- **cli:** Emit file-change + review-hunk events during paired sessions

### CI

- **release:** Make CLI npm publish idempotent

## [2.15.1] — 2026-05-17

### Fixed

- **jetbrains-plugin:** Import terminalopsservice in controllertoolwindowfactory
- **cli:** Lazy-load node-pty + vendor darwin prebuilds (cli was crashing on mac)

## [2.14.0] — 2026-05-17

### Added

- **cli,vsc-plugin,jetbrains-plugin:** Search_files content search via git grep
- **cli:** Terminal handlers via node-pty (cross-platform, conpty on windows)

## [2.13.0] — 2026-05-16

### Added

- **cli:** Forward CODEAM_VERCEL_BYPASS as x-vercel-protection-bypass

### CI

- **deps:** Cap @types/node major in CLI dependabot config

### Chore

- **deps:** Bump gradle-wrapper in /apps/jetbrains-plugin (#32)
- **deps:** Bump org.jetbrains.intellij.platform (#29)

## [2.12.17] — 2026-05-16

### Fixed

- **cli:** Submit multi-line composer prompts; document new commands + env vars
- **vsc-plugin:** Replace placeholder activity bar icon with branded </> mark

## [2.12.16] — 2026-05-15

### Documentation

- **meta:** Mention Codex support across CLI/VS Code/JetBrains/README

### Fixed

- **cli:** Scope codeam <agent> restore to that agent's most-recent session
- **cli:** Detect Codex shell-approval prompts as a select_prompt

## [2.12.14] — 2026-05-14

### Fixed

- **cli:** Dedent Codex's 2-space chat margin from diff lines

## [2.12.13] — 2026-05-14

### Fixed

- **cli:** Don't wrap diff / commit / PR / push / merge output in code fences

## [2.12.12] — 2026-05-14

### Fixed

- **cli:** Codex-specific renderer with DECSTBM scroll-region support — captures full multi-paragraph replies
- **cli:** Inject Markdown ``` fences for Codex-emitted code blocks

## [2.12.11] — 2026-05-14

### Fixed

- **cli:** Codex-specific renderer with DECSTBM scroll-region support — captures full multi-paragraph replies

## [2.12.10] — 2026-05-14

## [2.12.9] — 2026-05-14

### Fixed

- **shared:** Keep scrollback across alt-screen toggles + CSI 2J so multi-paragraph agent replies survive

### Debug

- **cli:** Always-on filter-input dump so we can diagnose multi-line drops

## [2.12.8] — 2026-05-14

### Debug

- **cli:** Always-on filter-input dump so we can diagnose multi-line drops

## [2.12.7] — 2026-05-14

### Fixed

- **cli:** File logging guard order — info+ lines now actually reach the file

## [2.12.6] — 2026-05-14

### Fixed

- **cli:** Always-on info+ file logging so chunk-send outcomes survive without CODEAM_DEBUG

## [2.12.5] — 2026-05-14

### Fixed

- **cli:** Rewrite filterCodexChrome — drop the brittle skipEchoContinuation state machine

## [2.12.4] — 2026-05-14

### Fixed

- **cli:** Report the real agent id/name/icon to /api/plugin/agents

## [2.12.3] — 2026-05-14

### Fixed

- **cli:** Drop the Codex bottom status footer + accept · as agent-reply prefix

## [2.12.2] — 2026-05-14

### Changed

- **cli:** Per-agent TUI parsers — Codex uses • for replies (same glyph as Claude tool calls)
- **cli,shared,vsc-plugin:** Move Claude TUI parsers out of shared into the Claude strategy

## [2.12.1] — 2026-05-14

### Fixed

- **cli:** Parse Codex rollouts for full transcripts + token usage

## [2.11.0] — 2026-05-13

### Added

- **shared:** Add agent type primitives
- **shared:** Add AGENT_REGISTRY with Claude enabled
- **shared:** Export agents module + bump minor
- **cli:** Define RuntimeStrategy + DeployStrategy interfaces
- **cli:** Implement ClaudeRuntimeStrategy
- **cli:** Implement ClaudeDeployStrategy + extract credential bridge
- **cli:** Add agent to SavedSession + preferredAgent to CliConfig
- **cli:** Add parseAgentFlag + promptForAgent helpers
- **cli:** Pair accepts --agent flag + prompts + remembers preferredAgent
- **cli:** Pair-auto consumes agent from API response
- **cli:** Change_model + summarize handlers route through RuntimeStrategy

### Changed

- **vsc-plugin:** Port JetBrains agent-strategy pattern
- **cli:** Extract Claude history parsing to agents/claude/history.ts
- **cli:** Extract Claude /usage parsing to agents/claude/quota.ts
- **cli:** Rename ClaudeService → AgentService, add registry factory
- **cli:** History + quota services delegate to RuntimeStrategy
- **cli:** Start.ts uses session.agent for runtime factory
- **cli:** Deploy uses DeployStrategy + switches to pair-auto
- **cli:** Pass args to pair command

### Documentation

- Align CLAUDE.md + bump in-source versions to v2.10.8
- **cli:** Drop misleading codeam-login note in deploy.ts

### Fixed

- **cli:** Reload config after addSession to avoid clobbering activeSessionId
- **cli:** Revert deploy PM2 wrapper to pair --agent=<id> (Phase 1 lacks user-JWT)

## [2.10.8] — 2026-05-12

### Fixed

- **cli:** Exclude pre-existing JSONLs from auto-detect so a fresh pair stays empty

### Performance

- **cli:** Idle backoff on polling fallback
- **vsc-plugin:** SSE pull primary with polling fallback
- **jetbrains-plugin:** SSE pull primary with polling fallback

### Tests

- **cli:** Update poll-cadence test to reflect idle-backoff behaviour

## [2.10.7] — 2026-05-11

### Fixed

- **cli:** Don't auto-detect + upload stale JSONL on boot

## [2.10.6] — 2026-05-11

### Added

- **jetbrains-plugin,vsc-plugin:** Install_cli_and_pair command

## [2.10.5] — 2026-05-11

### Added

- **jetbrains-plugin:** Render tables, code blocks and diffs from AI Assistant

## [2.10.4] — 2026-05-11

### Fixed

- **jetbrains-plugin:** AI Assistant send action needs anchored DataContext

## [2.10.3] — 2026-05-10

### Added

- **jetbrains-plugin:** Native JetBrains AI Assistant integration

## [2.10.2] — 2026-05-10

### Fixed

- **jetbrains-plugin:** Flexible Copilot model match + banner capture

## [2.10.1] — 2026-05-10

### Fixed

- **jetbrains-plugin:** Copilot model switch + quota error surfacing

## [2.10.0] — 2026-05-10

### Added

- **jetbrains-plugin:** Native Copilot Chat integration via internal API

### Changed

- **jetbrains-plugin:** Self-contained per-agent strategies

### Fixed

- **cli:** Lazy-detect conversation id in uploadDelta when eager-detect missed it

### Tests

- **cli:** Pin lazy-detect of conversation id in uploadDelta

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

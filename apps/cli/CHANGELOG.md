# Changelog

All notable changes to `codeam-cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

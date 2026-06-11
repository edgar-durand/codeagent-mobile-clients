# Changelog

All notable changes to the CodeAgent Mobile VS Code extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.36.2] — 2026-06-11

### Fixed

- **cli:** Drop BEADS_DIR so shared-server resolves the workspace from cwd

## [2.36.1] — 2026-06-11

### Fixed

- **cli:** Init beads workspace before starting dolt server + harden installer

## [2.36.0] — 2026-06-11

### Added

- **cli:** Per-OS dolt installer (install-dolt.ts)
- **cli:** Stable bd-safe prefix from projectKey (D16)
- **cli:** Shared dolt sql-server lifecycle (ensureSharedServer, D8)
- **cli:** Adapter runs in shared-server mode; correct stale embedded doc
- **cli:** Provision dolt + shared-server + per-prefix DB (D15-D17)
- **cli:** Export BEADS_DOLT_SHARED_SERVER to the agent (GAP 2, D15)
- **cli:** Harden dolt PATH resolution for codespaces
- **cli:** No-sudo dolt fallback (tarball -> ~/.local/bin) for locked-down containers

### Fixed

- **cli:** Make dolt PATH resolution host-independent (Windows CI)

## [2.35.9] — 2026-06-10

### Fixed

- **cli:** Suspend the prompt idle-watchdog while a tool call runs (#317)

## [2.35.8] — 2026-06-10

### Added

- **cli:** Handle group_mention_task (@codeagent runs + replies to group) (#316)

## [2.35.7] — 2026-06-10

### Fixed

- **cli:** Keep ACP thought + reply on distinct chunkIds (no kind flip) (#314)

### Tests

- **cli:** Make cliBinDir tests pass on the Windows shard (#313)

## [2.35.6] — 2026-06-10

### Fixed

- **cli:** Cancel the ACP turn on failure so the session isn't poisoned (#312)

## [2.35.5] — 2026-06-10

### Fixed

- **cli:** Make @beads/bd an optional dependency (#311)

## [2.35.4] — 2026-06-10

### Fixed

- **cli:** Make ACP prompt timeout idle-based, not total-elapsed (#310)

## [2.35.3] — 2026-06-10

### Fixed

- **cli:** Symlink bd into a WRITABLE on-PATH dir (~/.local/bin) for codespaces

## [2.35.2] — 2026-06-10

### Fixed

- **cli:** Bound preview install + add port-listening ready fallback
- **cli:** Stop resume_session from killing the agent dead

### Tests

- **cli:** Make linkBdOntoPath/cliBinDir provisioner tests OS-independent

## [2.35.1] — 2026-06-10

### Fixed

- **cli:** Sync package-lock with @beads/bd@1.0.5 (npm ci was failing on main CI)
- **cli:** Symlink bd into a dir that is actually on PATH

## [2.35.0] — 2026-06-10

### Fixed

- **shared:** Rename BeadsIngestPayload.deps to required dependencies
- **cli:** Symlink bd onto PATH + set git beads.role during provisioning
- **cli:** Set BEADS_DIR pre-spawn so the agent inherits the home brain
- **cli:** Always send dependencies + summary in beads ingest payload

## [2.34.0] — 2026-06-10

### Added

- **cli:** Beads home-brain provisioner (idempotent init, no bd setup)
- **cli:** Composition-root beads orchestrator + provisioning SSE signal
- **cli:** Run bd setup <recipe> --global so the agent uses bd natively (revert D12)

### Changed

- **cli:** Address beads home brain via BEADS_DIR, drop broken --global
- **cli:** Move beads provisioning to the composition root (SRP / D10)

## [2.33.0] — 2026-06-09

### Added

- **shared:** Beads wire types (ingest payload + action)
- **cli:** Bundle @beads/bd + cross-OS adapter, installer & projectKey
- **cli:** Beads bootstrap + issues.jsonl watcher -> backend
- **cli:** Apply queued beads actions as native bd commands
- **cli:** Gated beads orchestrator + barrel exports
- **cli:** Wire always-on beads into the live start + command-relay path

## [2.32.10] — 2026-06-09

### Fixed

- **cli:** Print a 'do not type here' relay notice when the agent goes online via ACP

## [2.32.9] — 2026-06-07

### Tests

- **cli:** Integration regression test for preview spawn → ready-pattern path

## [2.32.8] — 2026-06-07

### Chore

- Add FUNDING.yml — surface Sponsor button on the public repo

### Documentation

- Drop Vercel reference from SSE cap comment

### Fixed

- **cli:** Compile preview ready_pattern case-insensitive

## [2.32.7] — 2026-06-07

### Fixed

- **cli:** Use dns.lookup (OS resolver) as primary probe for cloudflared tunnel readiness
- **cli:** Keep Gemini snapshot valid as long as refresh_token is present

## [2.32.6] — 2026-06-07

### Fixed

- **cli:** Probe both A and AAAA records when waiting on cloudflared tunnel
- **cli:** Use dns.lookup (OS resolver) as primary probe for cloudflared tunnel readiness

## [2.32.5] — 2026-06-07

### Fixed

- **cli:** Run npx normalization AFTER preflight install, not before
- **cli:** Probe both A and AAAA records when waiting on cloudflared tunnel

## [2.32.4] — 2026-06-07

### Fixed

- **cli:** Accumulate stdout for preview ready_pattern matching
- **cli:** Run npx normalization AFTER preflight install, not before

## [2.32.3] — 2026-06-07

### Fixed

- **cli:** Accumulate stdout for preview ready_pattern matching

## [2.32.2] — 2026-06-07

### Fixed

- **cli:** Gemini ACP adapter passes --skip-trust
- **cli:** Rewrite `npx <bin>` → local binary before preview spawn

## [2.32.1] — 2026-06-07

### Fixed

- **cli:** Gemini ACP adapter passes --skip-trust

## [2.32.0] — 2026-06-07

### Added

- **cli:** Surface HTTP errors from requestCode + PATH-augment agent spawns

## [2.31.0] — 2026-06-07

### Chore

- **cli:** Drop originator-HMAC fields from /api/pairing/code

## [2.30.0] — 2026-06-06

### Added

- **vsc-plugin:** Banner recommends update when marketplace ships a fix
- **jetbrains-plugin:** Banner recommends update when marketplace ships a fix

### Fixed

- **cli:** Forward mobile image attachments to ACP as image blocks (QA #290)
- **cli, vsc-plugin:** Echo mobile prompts + clear Reconnecting UX (QA #287/#291)
- **cli:** Replace pair pollStatus with SSE pair_completed event (QA #285)

## [2.29.0] — 2026-06-06

### Added

- **cli:** Forward originator HMAC to /api/pairing/code for QR-ready SSE

## [2.28.1] — 2026-06-06

### Fixed

- **cli:** RequestCode times out at 10s instead of hanging forever

## [2.28.0] — 2026-06-06

### Added

- **cli:** Auto-update on stale version + re-exec into new binary

### Fixed

- **cli:** IDE terminal output + Save round-trip on ACP sessions
- **cli:** File-watcher honors .gitignore per-repo
- **cli:** Refresh pluginAuthToken on boot to survive JWT_SECRET rotation
- **cli:** Use /pairing/reconnect on boot to refresh token + activate session

### Diag

- **cli:** Log boot triple + on-401 triple to isolate INVALID_PLUGIN_TOKEN

## [2.27.16] — 2026-06-06

### Added

- **cli:** Wire FileWatcher + TurnFileAggregator into ACP runner

## [2.27.14] — 2026-06-06

### Added

- **cli:** Synthesize agent_banner welcome card after ACP handshake

## [2.27.13] — 2026-06-06

### Added

- **cli:** Flip ACP default ON for agents with adapter

## [2.27.12] — 2026-06-06

### Added

- **cli:** ACP runner full command coverage + history + rich-bubble feed

## [2.27.11] — 2026-06-06

### Fixed

- **cli:** Inline @agentclientprotocol/sdk into the bundle (Node 20 ERR_REQUIRE_ESM)

## [2.27.10] — 2026-06-06

### Fixed

- **cli:** ACP — single text buffer + drop kind-based fan-out + timeout leak

## [2.27.9] — 2026-06-06

### Fixed

- **cli:** ACP publishes to /api/commands/output (mobile's chat pipe)

## [2.27.8] — 2026-06-06

### Fixed

- **cli:** ACP — accumulate cumulative content per chunkId, isFinal on prompt-end

## [2.27.7] — 2026-06-06

### Fixed

- **cli:** ACP — wire-level instrumentation + prompt timeout

## [2.27.6] — 2026-06-06

### Fixed

- **cli:** ACP runner — ack every relay command + body envelope for auth

## [2.27.5] — 2026-06-06

### Chore

- **cli:** Drop cursor-agent-acp — pulls deprecated SDK

## [2.27.4] — 2026-06-06

### Tests

- **cli:** Fix gemini local-token tests on Windows

## [2.27.3] — 2026-06-06

### Added

- **cli:** Finish e2e Gemini support — link flow + runtime

## [2.27.2] — 2026-06-06

### Added

- **cli:** ACP runtime — plug-and-play replacement for per-agent PTY parsers
- **cli:** Wire Gemini through the ACP runtime (native --acp)

## [2.27.1] — 2026-06-05

### Fixed

- **vsc-plugin:** Drop backticks from brand-tokens CSS comment

## [2.26.16] — 2026-06-05

### Fixed

- **cli:** POST link-error signal to backend on validate-refuse (#259)

## [2.26.15] — 2026-06-05

### Fixed

- **cli:** Refuse to link Codex when local auth.json is already expired (#258)

## [2.26.14] — 2026-06-04

### Chore

- **deps:** Bump actions/setup-node from 4 to 6 (#246)
- **deps:** Bump actions/checkout from 4 to 6 (#247)
- **deps:** Bump org.jetbrains.kotlin.jvm in /apps/jetbrains-plugin (#248)
- **cli:** Bump which 2.0.2 → 5.0.0 (#251)

### Fixed

- **cli:** Drop redundant install from agent setup_commands + warn agent (#256)

## [2.26.13] — 2026-06-04

### Added

- **cli:** Pre-flight install for missing node_modules before preview (#250)

## [2.26.12] — 2026-06-04

### Fixed

- **cli:** Gate preview_ready on DNS resolution via c-ares + 1.1.1.1 (#249)

## [2.26.11] — 2026-06-03

### Added

- **cli:** Emit preview_progress SSE events at each bring-up milestone (#244)

## [2.26.10] — 2026-06-03

### Fixed

- **cli:** Cloudflared DNS probe is best-effort, no longer fails the preview (#243)

## [2.26.9] — 2026-06-03

### Added

- **cli:** Conversation push carries agentId for per-agent body cache (#242)

## [2.26.8] — 2026-06-03

### Added

- **cli:** Push resumable-session list per active agent (#241)

## [2.26.7] — 2026-06-03

### Fixed

- **cli:** Preview no longer pollutes the host terminal + waits for tunnel DNS (#240)

## [2.26.6] — 2026-06-03

### Fixed

- **cli:** Preview shutdown is graceful + parser tolerates prose-wrapped JSON (#239)

## [2.26.5] — 2026-06-03

### Fixed

- **vsc-plugin:** CopilotLmStrategy matches normalized agentId `copilot` (#238)

## [2.26.4] — 2026-06-03

### Fixed

- **vsc-plugin:** Route github.copilot-chat through vscode.lm; clipboard-only fallback (#237)

## [2.26.3] — 2026-06-03

### Fixed

- **jetbrains-plugin:** Silent token refresh on 401 — match VSC + CLI behaviour (#236)

## [2.26.2] — 2026-06-03

### Fixed

- **cli,vsc-plugin:** Silent token refresh via /api/pairing/reconnect — never interrupt the session (#235)

## [2.26.1] — 2026-06-03

### Fixed

- **workflow:** Drop stray `if-no-files-found: error` line from api-v2 dispatch step (#233)
- **vsc-plugin:** Event-driven AgentOutputMonitor + auth guard on output push (#234)

## [2.26.0] — 2026-06-03

### Added

- **workflow:** Cross-PR review by Claude Code on codex-authored PRs (#231)
- **cli,vsc-plugin:** Preview lifecycle + branch reporting (Phase 1B for #438) (#232)

### Fixed

- **workflow:** Use existing CROSS_REPO_PAT for api-v2 dispatch (#230)

## [2.25.0] — 2026-06-03

### Added

- **plugins:** Report PluginAgent.isTerminal for the 5 terminal agents (#229)

### Chore

- **templates:** Drop required fields QA flagged as friction (#216)
- **meta:** Split issue templates by surface — auto-applied labels (#224)

### Agent

- Implement issue #220 — Deleted session remains visible on Home screen until a manual refresh occurs (#222)
- Implement issue #218 — VS Code connection succeeds but messages remain stuck in "thinking" state and are never processed (#219)

## [2.24.0] — 2026-06-02

### Added

- **vsc-plugin,jetbrains-plugin:** Honor agent payload on install_cli_and_pair (#215)

### CI

- **workflow:** Agent-implements-issue — Codex picks up labelled issues (#200)
- **workflow:** Allow external reporters to trigger codex-action (#211)
- **workflow:** Forward mobile-app + api bugs to the private repo (#212)
- **workflow:** Pass --repo to gh issue comment in the forward job (#213)
- **workflow:** Forward — idempotent re-dispatch (#214)

### Chore

- **deps-dev:** Bump glob from 11.1.0 to 13.0.6 in /apps/vsc-plugin (#199)

### Fixed

- **jetbrains-plugin:** Use ensurePluginId for telemetry distinct_id

### Agent

- Implement issue #201 — docs(cli): document missing subcommands in README Commands table (#202)

## [2.23.37] — 2026-05-31

### Fixed

- **cli:** Drop ignored paths in file-watcher + turn aggregator

## [2.23.36] — 2026-05-31

### Changed

- **cli:** Move bracketed-paste into Claude strategy + agent-leak hook

### Fixed

- **cli:** Suppress bogus terminal-turn from Claude's ghost-text

## [2.23.35] — 2026-05-31

### Changed

- **cli:** Move bracketed-paste into Claude strategy + agent-leak hook

### Fixed

- **cli:** Wrap multi-line prompts in bracketed-paste so \r submits

## [2.23.34] — 2026-05-31

### Fixed

- **cli:** Wrap multi-line prompts in bracketed-paste so \r submits

## [2.23.33] — 2026-05-31

### Performance

- **cli:** Coalesce file-watcher emissions in a 250 ms window

## [2.23.32] — 2026-05-31

### Added

- **shared:** Add CommitEntry + BlameLine wire types for git enrichment
- **cli:** Capture git log + blame per changed file at turn end

## [2.23.31] — 2026-05-30

### Fixed

- **cli:** TurnFileAggregator captures pre-pair baseline silently

## [2.23.30] — 2026-05-30

### Chore

- **cli:** Info-level logging for AI summary/insight pipeline

### Fixed

- **cli:** DetectInputSuggestion skips Claude TUI box borders

## [2.23.29] — 2026-05-30

### Fixed

- **cli:** DetectInputSuggestion skips Claude TUI box borders

## [2.23.28] — 2026-05-30

### Changed

- **cli:** Gate idle-suggestion seed on per-agent opt-in

## [2.23.27] — 2026-05-30

### Fixed

- **cli:** Seed idle-suggestion detector with the established screen

## [2.23.26] — 2026-05-30

### Chore

- **meta:** No-polling rule + PreToolUse hook to enforce it

### Fixed

- **cli:** Event-driven input_suggestion via PTY data event

## [2.23.25] — 2026-05-30

### Fixed

- **cli:** Poll for input_suggestion after turn finalises

## [2.23.24] — 2026-05-30

### Added

- **cli:** Pre-assign Claude session id via --session-id, drop birthtime guesswork

## [2.23.23] — 2026-05-30

### Fixed

- **cli:** Get_conversation handler runs lazy detect when needed

## [2.23.22] — 2026-05-30

### Fixed

- **cli:** Anchor detectInputSuggestion on `? for shortcuts`

## [2.23.21] — 2026-05-30

### Added

- **cli:** Emit `input_suggestion` chunk for Claude ghost-text completions

## [2.23.20] — 2026-05-30

### Fixed

- **cli:** Claude selector — match `<n>.Label` (no space after the dot)

## [2.23.19] — 2026-05-30

### Fixed

- **cli:** Serialise prompt submissions while agent is busy

## [2.23.18] — 2026-05-28

### CI

- **release:** Fix JetBrains preflight URL + 404000 status-code bug

## [2.23.14] — 2026-05-28

### Fixed

- **cli:** Pair-auto stays alive in heartbeat-only mode on CODEAM_SKIP_AGENT_LAUNCH
- **cli:** Pair-auto runs full infra-only loop (file watcher + IDE commands + heartbeat)

## [2.23.13] — 2026-05-28

### Fixed

- **cli:** Pair-auto stays alive in heartbeat-only mode on CODEAM_SKIP_AGENT_LAUNCH

## [2.23.12] — 2026-05-27

### Fixed

- **cli:** Auto-enable codespace keep-alive on start

## [2.23.11] — 2026-05-27

### Fixed

- **cli:** DetectStartupBanner matches Claude v2.1.x box-drawn welcome

## [2.23.10] — 2026-05-27

### Added

- **cli:** Pair-auto honors CODEAM_SKIP_AGENT_LAUNCH (#198)

## [2.23.9] — 2026-05-27

### Added

- **cli:** Auto-link the chosen agent's creds inside codeam pair (#197)

## [2.23.8] — 2026-05-26

### Added

- **cli:** Capture ~/.claude.json on codeam link claude (#196)

## [2.23.7] — 2026-05-26

### Added

- **cli:** Emit typed agent_banner chunk for Claude startup splash (#195)

## [2.23.6] — 2026-05-26

### Fixed

- **cli:** Raise listProjectFiles cap from 5000 to 50000 (#194)

## [2.23.5] — 2026-05-25

### Added

- **cli:** Report current git branch on every heartbeat (#193)

## [2.23.4] — 2026-05-25

### Fixed

- **cli+workflow:** Unblock prompt flow + restore PostHog telemetry (#192)

## [2.23.3] — 2026-05-25

### Fixed

- **cli:** Reap in-flight spawnAndCapture children on sigint/exit (#191)

## [2.23.2] — 2026-05-25

### Fixed

- **cli:** Fire-and-forget background handlers so they don't block start_task (#190)

## [2.23.1] — 2026-05-25

### Fixed

- **cli:** Payload.agentId — accept null, not just undefined (#189)

## [2.23.0] — 2026-05-25

### Added

- **cli:** AI insights — generateOneShot + handlers (PR 2 of 6) (#188)

## [2.22.1] — 2026-05-25

### Fixed

- **cli:** Payload.agentId — accept any string, not just the public enum (#187)

## [2.22.0] — 2026-05-25

### Added

- **cli:** Handle request_link_credentials from backend auto-link (#186)

## [2.21.2] — 2026-05-25

### Fixed

- **workflow:** Bake POSTHOG_API_KEY into VS Code + JetBrains plugin builds

## [2.21.1] — 2026-05-25

### Added

- **cli:** Apply_file_review handler — git add / git restore on the worktree

### Fixed

- **cli+vsc-plugin:** CI failures — stop-aware retries + VSC git-root seam

## [2.21.0] — 2026-05-25

### Added

- **cli:** End-of-turn batch aggregator + JSONL outbox
- **cli:** Dirty-flag optimisation — skip git for un-touched repos

## [2.20.3] — 2026-05-25

### Fixed

- **cli:** Drain pending timers in afterEach to stop test leaks

## [2.20.2] — 2026-05-25

### Fixed

- **cli+vsc-plugin+jetbrains-plugin+shared:** Walk up to enclosing git root per file event

## [2.20.1] — 2026-05-25

### Documentation

- Document CODEAM_TEST_MODE + CODEAM_API_URL env vars in README (#177)

### Fixed

- **cli:** Finalize turn on content-stable + ready-prompt, not just PTY-idle (#178)

## [2.20.0] — 2026-05-24

### Added

- **shared:** CODEAM_TEST_MODE env var to route clients at dev preview (#176)

## [2.19.0] — 2026-05-24

### Added

- **both-plugins:** PostHog telemetry, mirrors the CLI (closes #95) (#142)
- **both-plugins:** Bundle Hanken Grotesk + JetBrains Mono fonts (closes #96) (#147)
- **vsc-plugin:** Add Copy Install Command CTA to empty agents state (closes #116) (#166)
- **vsc-plugin:** 3-state status bar with rich Markdown tooltip (closes #115) (#167)
- **both-plugins:** All-detector agent discovery; enable cursor/coderabbit/aider (closes #102 follow-up) (#171)
- **both-plugins:** A11y pass — ARIA, focus rings, mnemonics, focus order (closes #106) (#172)
- **both-plugins:** FooterStatusStrip — at-a-glance connection summary (closes #114) (#174)
- **vsc-plugin:** Brand polish — GlassCard + cyberpunk h3 voice (closes #79) (#175)

### CI

- Drop node 18 + skip Vitest on Windows + advisory backend probes (#128)

### Changed

- **vsc-plugin:** Split controller-panel.ts (partial #89) (#143)
- **jetbrains-plugin:** Extract RemoteCommandRouter (partial #89) (#144)
- **jetbrains-plugin:** Split AgentOutputMonitor — publisher + text utils (partial #89) (#145)
- **both-plugins:** Remove dead WebSocketService + AgentBridgeService (closes #90) (#149)
- **jetbrains-plugin:** Extract RoundedPanel + DeviceConnectionPanel (further #89) (#151)
- **jetbrains-plugin:** Split TerminalAgentService — publisher + reader (further #89) (#152)
- **jetbrains-plugin:** Extract Swing-walk helpers from AgentOutputMonitor (further #89) (#153)
- **jetbrains-plugin:** Extract Cascade JS + Codeium process tap (further #89) (#154)
- **jetbrains-plugin:** Extract AIAssistant text-extraction helpers (further #89) (#155)
- **jetbrains-plugin:** Extract JcefCaptureState from AgentOutputMonitor (closes #89 follow-up) (#156)
- **jetbrains-plugin:** Split ControllerPanel HTTP + QR + row factory (closes #89 follow-up) (#157)
- **shared:** Centralize PROTOCOL_VERSION + lifecycle constants (closes #97) (#164)
- **both-plugins:** Lock notification voice to canonical CodeAgent Mobile copy (closes #105) (#165)
- **vsc-plugin:** Deprecate Claude PTY-directo + Claude handlers (closes #102) (#169)
- **jetbrains-plugin:** Deprecate Claude PTY-directo + handlers (closes #102) (#170)

### Chore

- **jetbrains-plugin:** Delete dead RobotPasteStrategy (partial #90) (#139)
- **workflow:** Delete release-single.yml — drift surface (closes #110) (#158)
- **both-plugins:** Wire logger.trace into every empty catch (closes #111) (#173)

### Fixed

- **ci:** Smoke test reads stderr too — banners moved off stdout in v2.18.x
- **vsc-plugin:** Add webview CSP + render QR locally (closes #70) (#117)
- **both-plugins:** Store pluginAuthToken in SecretStorage / PasswordSafe (closes #71) (#118)
- **vsc-plugin:** Authenticate the observer-bridge on 127.0.0.1:47832 (closes #72) (#119)
- **vsc-plugin:** Realpath candidate + workspace before sandbox check (closes #73) (#120)
- **vsc-plugin:** Gate workbench-injection cleanup behind a one-shot flag (closes #74) (#121)
- **jetbrains-plugin:** Drop untilBuild cap + re-enable plugin-structure warnings (closes #76) (#122)
- **jetbrains-plugin:** Adopt CodeAgent Mobile brand palette + drop stale strings (closes #80) (#123)
- **jetbrains-plugin:** Lift resume_session 500ms sleeps off EDT + WS reader (partial #75) (#124)
- **jetbrains-plugin:** Surface action group under Tools menu (closes #77) (#125)
- **both-plugins:** 401 recovery — clear token, stop transports, surface re-pair UX (closes #78) (#126)
- **vsc-plugin:** Adopt CodeAgent brand palette in webview (partial #79) (#127)
- **cli:** Make tests + parser cross-platform; restore Windows in CI (#129)
- **both-plugins:** Align clearRemoteOutput on CLI wire shape (closes #83) (#130)
- **both-plugins:** Honor heartbeatIntervalMs setting in CommandRelayService (closes #84) (#131)
- **both-plugins:** Cap base64 attachments at 10 MB (closes #92) (#132)
- **both-plugins:** Refuse to overwrite malformed MCP config (closes #93) (#133)
- **vsc-plugin:** Exclude .pdb + tests from .vsix (closes #86) (#134)
- **both-plugins:** De-dup commands by id on SSE reconnect (closes #85) (#135)
- **both-plugins:** Surface a 3-state Connected/Reconnecting/Offline dot (closes #94) (#136)
- **both-plugins:** Align strategy contract — same fields + StrategyResult (closes #82) (#137)
- **vsc-plugin:** Defer eager activation work to first pair (closes #87) (#138)
- **both-plugins:** Align command-handler surface (closes #81) (#140)
- **vsc-plugin:** Drop Python PTY helper, route Claude through node-pty (closes #88) (#146)
- **jetbrains-plugin:** Lift remaining EDT-blocking sites in dispatch (closes #75) (#150)
- **jetbrains-plugin:** Multi-IDE verifier matrix + dynamic-plugin marker (closes #100, #108) (#159)
- **jetbrains-plugin:** Track all known projects in IdeIntegrationService (closes #99) (#160)
- **vsc-plugin:** Per-window port + per-workspace pluginId (closes #103) (#161)
- **vsc-plugin:** Cache SettingsService config + react to mid-session changes (closes #107) (#162)
- **vsc-plugin:** Drop \`as unknown as Record<string, unknown>\` casts (closes #104) (#163)

### Tests

- **vsc-plugin:** Cover webview-security helpers + extract sanitizeSessionId (partial #91) (#141)
- **vsc-plugin:** Cover CommandRelayService dispatch + dedup + state (closes #91) (#148)

## [2.18.2] — 2026-05-24

### Fixed

- **cli:** Doctor node-pty check uses vendored loader + skips non-windows

## [2.18.1] — 2026-05-24

### Added

- **cli:** Split AgentStrategy into Interactive + Batch shapes (#58)
- **cli:** CodeRabbit BatchAgentStrategy (#59)
- **cli:** Cursor agent strategy (InteractiveAgentStrategy) (#60)
- **cli:** Aider agent strategy (InteractiveAgentStrategy) (#61)
- **cli:** \`codeam doctor\` diagnostic command (#64)
- **cli:** PostHog telemetry with full session + user context (#65)
- **cli:** Log rotation + JSON mode + XDG-aware paths (#66)
- **cli:** Quick wins bundle — banner→stderr, unknown cmd, exit-codes, --api-key-file, logout heartbeat (#67)
- **cli:** Unknown-command typo suggester + shell completion command (#68)

### CI

- **cli:** MacOS runner + Node 18/20/22 matrix + coverage gate (#63)

### Changed

- **cli:** Extract OsStrategy interface — pure helpers slice (#48)
- **cli:** Move buildClaudeLaunch wrap to OsStrategy.buildLaunch (#49)
- **cli:** Inject OsStrategy into RuntimeStrategy — compose, don't branch (#50)
- **cli:** Move PTY factories under OsStrategy.createPtyStrategies (#51)
- **cli:** Relocate claude-resolver + claude-installer to agents/claude/ (#53)
- **cli:** Extract LinkStrategy + drop link.ts AGENT_META hardcode (#56)
- **cli:** Switch HistoryService to /api/sessions/conversation + /list (#54)

### Fixed

- **cli:** AgentService.restart routes through RuntimeStrategy (#52)
- **cli:** Cap PtyBuffer + StreamingEmitter rawBuffer + eager cleanup on exit (#57)
- **cli:** Doctor marks agent-binary probes as optional

### Tests

- **cli:** Agent contract suite — one spec runs against every registered agent (#62)

## [2.17.7] — 2026-05-24

### Fixed

- **cli:** Correctness bug fixes — shell:true, execSync(string), pair-auto hang, non-atomic config

### Tests

- **vsc-plugin:** Pin PS5 regression case to powershell.exe only
- **vsc-plugin:** Drop flaky PS5 regression case

### Revert

- **vsc-plugin,jetbrains-plugin:** Drop install_cli_and_pair --agent forwarding

## [2.17.6] — 2026-05-23

### Revert

- **vsc-plugin,jetbrains-plugin:** Drop install_cli_and_pair --agent forwarding

## [2.17.5] — 2026-05-23

### Added

- **vsc-plugin,jetbrains-plugin:** Forward selected agent to codeam pair

### Fixed

- **vsc-plugin,jetbrains-plugin:** Npx fallback when codeam fails on PS5

## [2.17.4] — 2026-05-23

### Fixed

- **vsc-plugin,jetbrains-plugin:** Npx fallback when codeam fails on PS5

## [2.17.3] — 2026-05-23

### Fixed

- **cli:** Streaming-chunk POSTs need sessionId+pluginId in body
- **vsc-plugin,jetbrains-plugin:** Use PS5-compatible install command on Windows

### Tests

- **vsc-plugin,jetbrains-plugin:** Pin cross-OS install command builder

## [2.17.2] — 2026-05-22

### Fixed

- **cli:** Streaming-chunk POSTs need sessionId+pluginId in body

## [2.17.1] — 2026-05-22

### Fixed

- **cli:** Agent-aware spawn errors; Codex auto-install refresh PATH

## [2.17.0] — 2026-05-22

### Added

- Detect OpenAI Codex in VS Code + JetBrains plugins (#46)

### CI

- **vsc-plugin:** VS Code E2E workflow — open panel + pair-backend probe (#45)

### Fixed

- **cli:** Windows EPERM #43 + cross-OS CI smoke matrix + agent-creds tests
## [2.16.1] — 2026-05-21

### Fixed

- **cli:** Codeam link — auto-install, multi-probe creds, file-watcher login (#42)

## [2.16.2] — 2026-05-22

### Chore

- **meta:** Expand issue templates with question + documentation forms

### Documentation

- **shared:** Correct prod URL in api-url history comment

### Fixed

- **cli:** Codeam link — auto-install, multi-probe creds, file-watcher login
- **cli:** Windows EPERM crash from chokidar watching user-profile junctions (#43)

## [2.16.1] — 2026-05-21

### Fixed

- **cli:** Codeam link — auto-install, multi-probe creds, file-watcher login (#42)

## [2.16.0] — 2026-05-21

### Added

- **cli,vsc-plugin,jetbrains-plugin:** Codeam link <agent> CLI handoff (#41)

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

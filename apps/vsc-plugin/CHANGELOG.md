# Changelog

All notable changes to the CodeAgent Mobile VS Code extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.61.87] — 2026-08-08

### Fixed

- **cli:** Raise fleet create/recreate docker-run timeout for the inline image pull (#593)

## [2.61.86] — 2026-08-07

### Fixed

- **cli:** Per-tools/call watchdog on the httpUrl MCP relay (agent hang → clean tool error) (#592)

## [2.61.85] — 2026-08-06

### Fixed

- **cli:** Resume the prior conversation on a warm re-launch into an existing workspace (#591)

## [2.61.84] — 2026-08-05

### Fixed

- **cli:** Internal-path guard no longer denies the self-hosted workspace (#587)

## [2.61.83] — 2026-08-05

### Fixed

- **cli:** House-agent proxy env survives a codespace sleep/wake (#586)

## [2.61.82] — 2026-08-04

### Added

- **cli:** Host-allow preview dev servers behind the Cloudflare tunnel (#582)
- **cli:** Reuse the project .env across sessions of the same repo (#583)

### Fixed

- **cli:** Don't clobber a delivered reply when the completion ACK 404s (#584)

## [2.61.81] — 2026-08-03

### Added

- Convex works headlessly via a built-in admin-API MCP

## [2.61.80] — 2026-08-03

### Fixed

- **cli:** MCP tools/call watchdog — a hung MCP server no longer wedges the turn

## [2.61.79] — 2026-07-31

### Fixed

- **shared:** Convex uses the api_key (deploy key) rail, not OAuth

## [2.61.78] — 2026-07-31

### Added

- **shared:** Session-tools wire — SESSION_INTEGRATIONS_CHANGED event + repo stack-detect maps
- **cli:** Session-tools relay — integrations_sync + integrations_detect handlers

## [2.61.77] — 2026-07-31

### Added

- **shared:** Add Convex (convex.dev) database integration

## [2.61.76] — 2026-07-30

### Added

- **shared:** Add code-naming Agent Skill (CodeAesthetic naming guidelines) (#572)

## [2.61.75] — 2026-07-29

### Fixed

- **cli:** Stop misclassifying house-agent 403 usage-ceiling as an auth failure (#568)

## [2.61.74] — 2026-07-29

### Fixed

- **cli:** Resume a session in its own deploy-workspace cwd (warm-codespace wake loses conversation) (#567)

### Tests

- **cli:** Fix sweepStaleCliStagingDirs test on windows (path.basename, not split('/')) (#564)

## [2.61.73] — 2026-07-29

### Added

- **cli:** Honor suppressOnboardingWelcome on self-hosted/warm deploys (#562)

## [2.61.72] — 2026-07-29

### Fixed

- **cli:** Stop the Headroom :8787 proxy respawn loop (pid-check + grace + spawn lock) (#560)

## [2.61.71] — 2026-07-28

### Added

- **cli:** Watch + re-sync the Claude credential to the vault on rotation

## [2.61.70] — 2026-07-28

### Added

- **cli:** Self_hosted_cleanup — rm a deleted session's on-disk workspace on the box

## [2.61.69] — 2026-07-28

### Added

- **cli:** ACP internals guard — deny agent access to CodeAgent platform files on managed deploys

## [2.61.68] — 2026-07-28

### Changed

- **shared:** Rename integration category deployment -> infrastructure ⚠️ BREAKING CHANGE

## [2.61.67] — 2026-07-28

### Added

- **shared:** Cloudflare integration (deployment, OAuth + Cloudflare MCP)

## [2.61.66] — 2026-07-28

### Added

- **shared:** Figma dual-auth (OAuth primary + PAT fallback) — enable design

## [2.61.65] — 2026-07-28

### Added

- **shared:** Enable Microsoft Teams (comms, OAuth Graph + teams MCP)

## [2.61.64] — 2026-07-28

### Added

- **shared:** Confluence catalog entry (docs) — alias of Atlassian/Jira

## [2.61.63] — 2026-07-28

### Added

- **shared:** Supabase integration (database, OAuth)

## [2.61.62] — 2026-07-28

### Added

- **shared:** Postman + Mixpanel integrations (api_key)

## [2.61.61] — 2026-07-27

### Added

- **shared:** N8n integration (automation, api_key + n8n MCP)

## [2.61.59] — 2026-07-27

### Added

- **shared:** Enable ClickUp integration (OAuth app registered)

## [2.61.58] — 2026-07-27

### Added

- **shared:** ClickUp integration (tracker, OAuth) — DARK

## [2.61.57] — 2026-07-27

### Added

- **shared:** Trello integration (tracker, api_key rail + Trello MCP)

## [2.61.56] — 2026-07-27

### Added

- **shared,cli:** Replace OmniRoute agent with OpenRouter ⚠️ BREAKING CHANGE

## [2.61.55] — 2026-07-27

### Tests

- **shared:** Drop vercel from the COMING SOON golden (now live)

## [2.61.53] — 2026-07-27

### Added

- **shared:** Enable Vercel integration (headless Bearer live-verified)

## [2.61.52] — 2026-07-27

### Added

- **shared:** Vercel integration (deployment category, OAuth + hosted MCP) — DARK

## [2.61.51] — 2026-07-27

### Added

- **shared,cli:** Opencode is api_key (env-var provider keys), like aider

## [2.61.50] — 2026-07-27

### Added

- **shared,cli:** Opencode agent — foundation (identity + ACP adapter)
- **cli:** Opencode runtime + credential delivery + box bake

## [2.61.49] — 2026-07-27

### Added

- **cli:** Self-hosted OmniRoute gateway (skip MiniMax pin when omniRoute)

## [2.61.48] — 2026-07-26

### Added

- **shared:** OmniRoute as a LinkedAgentId (maps to internal claude)

## [2.61.47] — 2026-07-26

### Added

- **shared:** Stitch integration (api_key, hosted MCP over HTTP transport, design)

## [2.61.46] — 2026-07-26

### Added

- **shared,cli:** Datadog integration + httpUrl templating (2 keys + regional site)

## [2.61.45] — 2026-07-26

### Added

- **shared,cli:** PostHog integration + mcp-shim HTTP transport

## [2.61.44] — 2026-07-25

### Added

- **shared:** Resend integration — api_key (send-only comms), excluded from From-Conversation

## [2.61.43] — 2026-07-25

### Added

- **shared:** Discord comms integration — OAuth bot-invite, guildId discriminator

## [2.61.42] — 2026-07-25

### Added

- **cli:** Host-agent deploy supports a specific branch/ref

## [2.61.41] — 2026-07-25

### Fixed

- **cli:** Bypass the box-wide pair-auto singleton for host-agent children

## [2.61.40] — 2026-07-25

### CI

- **release:** Auto-refresh the wrapper-repo Codespaces prebuild on each release

### Fixed

- **cli:** Host-agent supports concurrent multi-session (per-deploy daemon lock)

## [2.61.39] — 2026-07-25

### Performance

- **cli:** Un-gate the agent spawn from beads provisioning (codespace)

## [2.61.38] — 2026-07-24

### Fixed

- **box:** Bake procps (`ps`) into the image — Beads/Dolt need it to manage the shared server

## [2.61.37] — 2026-07-24

### Fixed

- **box:** Agent pre-install verification is non-fatal — a flaky curl installer must not fail the build

## [2.61.35] — 2026-07-24

### Fixed

- **box:** Box user must own /home/box — set HOME late so the build doesn't root-own ~/.codeam

## [2.61.34] — 2026-07-24

### Added

- **box:** Pre-install every agent + gh/glab + beads/dolt/headroom in the fleet image

## [2.61.33] — 2026-07-24

### Added

- **cli:** GitLab deploy support on the box — glab + gitlab.com clone

## [2.61.32] — 2026-07-24

### Added

- **shared:** Add GitLab as a version_control integration

## [2.61.31] — 2026-07-24

### Added

- **shared:** Make GitHub a first-class version_control integration

## [2.61.30] — 2026-07-24

### Added

- **shared:** Add github_issues as a derived tracker integration

## [2.61.29] — 2026-07-24

### Added

- **shared:** Add Discord to the comms catalog (coming soon)

## [2.61.28] — 2026-07-24

### Added

- **shared:** Add Microsoft Teams + Google Chat to the comms catalog (coming soon)

### CI

- **cli:** Run macOS/Windows only on main + nightly, not every PR

## [2.61.27] — 2026-07-24

### Added

- **shared:** Add spec-driven-development skill + split skills into per-file modules

### Fixed

- **shared:** Add PR_REVIEW_LAUNCH to USER_EVENTS (sync A↔B drift)

## [2.61.26] — 2026-07-23

### Fixed

- **cli:** Classify 'OAuth session expired … could not be refreshed' as an auth failure

## [2.61.25] — 2026-07-23

### Fixed

- **host-agent:** Enrol + present a control-channel poll secret (self-hosted deploy root fix)

## [2.61.24] — 2026-07-22

### Chore

- **cli:** Declare yaml as devDependency (skills materialize test)
- **deps:** Bump actions/setup-node from 4 to 7 (#452)
- **deps-dev:** Bump typescript from 6.0.3 to 7.0.2 in /apps/cli (#432)
- **deps-dev:** Bump typescript from 6.0.3 to 7.0.2 in /apps/vsc-plugin (#430)
- **deps:** Bump org.jetbrains.kotlin.jvm in /apps/jetbrains-plugin (#453)
- **deps:** Bump ignore from 5.3.2 to 7.0.6 in /apps/cli (#323)
- **deps:** Bump org.jetbrains.intellij.platform (#454)

### Fixed

- **cli:** Break self-hosted enroll-token crash-loop on identity self-heal

## [2.61.23] — 2026-07-20

### Added

- **shared:** Add Agent Skills wire types (SkillDefinition, SkillsManifest)
- **shared:** Seed SKILL_REGISTRY with code-review + resolve-conflicts
- **cli:** Skills.json manifest read/persist/clear util
- **cli:** Materialize curated SKILL.md bundles under $HOME (namespaced)
- **cli:** ProvisionSkillsForStart materializes skills before agent spawn
- **cli:** Persist self-hosted deploy skills manifest to skills.json
- **cli:** Skills_configure relay command (add/remove/list) in both registries
- **shared:** Add skillIds to AgentReviewPlan wire type

### Fixed

- **cli:** SKILL.md frontmatter name must match codeam-<id> skill dir
- **cli:** ConfigureSkill rejects unknown action instead of destructive remove fall-through
- **cli:** Quote SKILL.md description (valid YAML) + harden skills manifest read

### Tests

- **cli:** Make skills path assertions separator-agnostic (Windows CI)

## [2.61.21] — 2026-07-18

### Added

- **shared:** Add GitHub brand mark to INTEGRATION_BRANDING catalog

## [2.61.20] — 2026-07-18

### Added

- **shared:** Add vcs integration category + GitHub PR wire types
- **cli:** CodeRabbit PR-review handler + vcs_agent_review command

### Changed

- **shared:** Defer first-class GitHub integration (keep PR wire types + event)

## [2.61.19] — 2026-07-18

### Fixed

- **cli:** Omit model context window when it isn't a real catalog match (no fake 200K)

## [2.61.18] — 2026-07-18

### Added

- **cli:** List_models reports the in-use model (currentModelId)
- **cli:** Native ACP model + mode list/switch (single source of truth, no hardcoded/hacky)

## [2.61.17] — 2026-07-18

### Fixed

- **cli:** Reuse bounded adapter-resolve retry in baton + codespace-gate paths; honest fail-then-succeed retry test
- **cli:** Make buildNpmInstallInvocation platform-injectable → deterministic cross-OS tests (fixes red Windows CI)
- **cli:** Never wipe a streamed transcript on a turn error (false 'couldn't finish')

## [2.61.16] — 2026-07-17

### Fixed

- **cli:** ACP dispatch is registry-static — never silently downgrade an ACP agent to PTY

## [2.61.15] — 2026-07-17

### Added

- **shared:** Integration category field + getIntegrationsByCategory

## [2.61.14] — 2026-07-17

### Fixed

- **shared:** Dark-launch figma integration pending Figma app review

## [2.61.13] — 2026-07-17

### Added

- **shared:** Add figma integration (read-only, figma-developer-mcp@0.13.2)

### Fixed

- **cli:** Complete RemoteCommand literal in resume-session test (typecheck gate)

## [2.61.11] — 2026-07-16

### Fixed

- **cli:** Periodic 12h re-baseline so an idle session's conversation outlives the backend TTL

## [2.61.10] — 2026-07-16

### Fixed

- **cli:** Fleet box hardening — self-updatable image, fresh-pull creates, dead-container rm

## [2.61.9] — 2026-07-16

### Fixed

- **cli:** Push RECENT list + transcript on ACP session START (idle resume was empty) + sudo self-update

## [2.61.8] — 2026-07-16

### Added

- **cli:** Agent-agnostic RECENT list + auto-resume latest conversation (ACP session/list)

### Fixed

- **cli:** Wrap public loadSession() with the load-replay guard (keystone)

### Tests

- **cli:** Harness invariant — no unguarded connection.loadSession

## [2.61.7] — 2026-07-16

### Fixed

- **cli:** Auto-resume the user's session on host-agent restart (no churn)
- **cli:** Engines-compat test uses CommonJS require (was import.meta → tsc fail)

## [2.61.5] — 2026-07-16

### Added

- **cli:** ACP chrome-leak canary + detector (stability monitor, part 2)
- **ci:** Canary seeds onboarding + auths via in-house MiniMax backend

### Fixed

- **ci:** Canary auths by subscription (CLAUDE_CODE_OAUTH_TOKEN), not API key
- **cli:** Stop the changeset reporter from spamming install/SDK files

## [2.61.4] — 2026-07-16

### Fixed

- **box:** Add unzip for CodeRabbit install (curl alone insufficient)
- **cli:** Bump ACP stack to latest + freeze claude binary (broken-chat fix)

## [2.61.3] — 2026-07-16

### Fixed

- **cli:** Fleet box survives restart instead of dying on expired enroll token
- **cli:** CodeRabbit setup works on fleet boxes (curl + install timeout)

## [2.61.2] — 2026-07-16

### Added

- **shared:** Add fleet_box_ready user event
- **cli:** Host_list_dir — read-only directory browse for the deploy path picker

### Tests

- **cli:** Host_list_dir handler (lists dir + failed path via relay result)
- **cli:** Host_list_dir failed-path assertion is cross-platform (path.resolve normalizes on Windows)

## [2.61.1] — 2026-07-15

### Documentation

- **cli:** CODEAM_HOST_LABEL / resolveHostLabel + fleet box 'CodeAgent Box' label

### Fixed

- **cli:** Cross-platform preview-port reclaim (Windows taskkill, not a no-op)

## [2.61.0] — 2026-07-15

### Added

- **cli:** Dynamic host label at enroll (hostname / CODEAM_HOST_LABEL) instead of my-server

## [2.60.70] — 2026-07-15

### Added

- **cli:** Fleet control plane — DockerRunner + fleet_* box handlers
- **box:** Production codeam-box rescue-fleet runtime image

### Chore

- **meta:** Register box/test commitlint scopes for the fleet work

### Documentation

- **fleet:** CLAUDE.md fleet CLI section

### Fixed

- **cli:** Deliver fleet box enroll token via env passthrough, not docker argv

### Tests

- **test:** Real-Docker integration gate for the fleet control plane

## [2.60.69] — 2026-07-15

### Fixed

- **cli:** Provision uvx via the standalone uv installer and resolve per-user bin paths for MCP launchers

## [2.60.68] — 2026-07-15

### Added

- **shared:** 17 new COMING SOON integrations + official logos

## [2.60.67] — 2026-07-15

### Added

- **shared:** Add Azure DevOps — first api_key (PAT) integration

## [2.60.66] — 2026-07-15

### Added

- **shared:** Add Notion as a live Agent Toolkit integration

## [2.60.65] — 2026-07-15

### Added

- **cli:** At-least-once command delivery — dedupe + ack (bulletproof first-prompt loss)

## [2.60.64] — 2026-07-15

### Added

- **shared:** Add Slack search:read scope (agent can search the user's messages)

### Documentation

- **shared:** Clarify Slack uses a USER token (agent acts as the user)

## [2.60.63] — 2026-07-15

### Added

- **shared:** Add Slack as a live Agent Toolkit integration

## [2.60.62] — 2026-07-15

### Added

- **shared:** Add Linear as a live Agent Toolkit integration

## [2.60.61] — 2026-07-15

### Added

- **shared:** Sentry full read+write scopes + --add-scopes on the MCP server

## [2.60.60] — 2026-07-14

### Added

- **shared:** Use Sentry's official mark for the integration catalog icon

## [2.60.59] — 2026-07-14

### Added

- **shared:** Enable Sentry integration (OAuth app registered)

## [2.60.58] — 2026-07-14

### Added

- **shared:** Register Sentry integration (dark) + BrokeredIntegrationToken.host

## [2.60.57] — 2026-07-14

### Fixed

- **cli:** Preview reclaims its own port after a CLI restart (no more 'port in use' dead-end)

## [2.60.56] — 2026-07-14

### Fixed

- **cli:** Deliver loopback OAuth callback via HTTP GET, not stdin write

## [2.60.55] — 2026-07-14

### Fixed

- **cli:** Two-tier ACP idle watchdog — context compaction no longer bricks the session

## [2.60.54] — 2026-07-13

### Fixed

- **cli:** Give the CodeRabbit browser login a user-paced timeout (15 min)

## [2.60.53] — 2026-07-12

### Fixed

- **shared:** Atlassian logo — replace stop-color=inherit with explicit #2684FF (react-native-svg can't resolve inherit)

## [2.60.52] — 2026-07-12

### Added

- **shared:** Rebrand Jira integration to Atlassian (Jira + Confluence) — display + Confluence scopes, id kept

### Fixed

- **cli:** Swallow session/load history replay during kimi Session-closed recovery (no prior-turn text prepended)
- **cli:** Wire load-replay swallow into the baton AcpClient too (kimi recovery)

## [2.60.51] — 2026-07-12

### Fixed

- **cli:** Recover kimi ACP 'Session is closed' by re-establishing the session + retry (multi-turn)

### Tests

- **cli:** Reusable ACP-provision smoke harness (per-agent real handshake auth check; automates CLAUDE.md Step 8)

## [2.60.50] — 2026-07-11

### Fixed

- **cli:** Guard kimi ACP login-state slot + real `kimi acp` regression test

## [2.60.49] — 2026-07-11

### Fixed

- **cli:** Write kimi managed-provider config.toml on provisioning (0.23.5 empty-response regression)

## [2.60.48] — 2026-07-11

### Added

- **shared:** Centralized integration branding catalog (official logos + display metadata)

### Changed

- **vsc-plugin:** Remove dead MCP config writer
- **jetbrains-plugin:** Remove dead MCP config writer

### Tests

- **cli:** Retry+swallow Windows EBUSY on temp-dir teardown (flaky main CI)

## [2.60.47] — 2026-07-11

### Added

- **cli:** Integrations manifest store + broker token client
- **cli:** Codeam mcp-run — token-refreshing stdio shim for integration MCP servers
- **cli:** Inject integration MCP servers into ACP sessions from the deploy manifest
- **shared:** StaticEnv on IntegrationMcpDelivery + pin mcp-atlassian==0.22.1 (jira needs ATLASSIAN_OAUTH_ENABLE)

### Fixed

- **cli:** Truncate broker error detail to 200 chars in thrown message
- **cli:** Mcp-run proxy — stale-child teardown, SIGKILL escalation, sentinel replay id, fail-fast on mid-swap death
- **cli:** Mcp-run proxy — cancelled-request inflight cleanup, token-fetch-before-teardown, pip output off stdout

### Tests

- **cli:** Docker integration test — mcp-run shim end-to-end with real mcp-atlassian

## [2.60.46] — 2026-07-11

### Added

- **shared:** IntegrationDefinition registry + integration user-event names (Agent Toolkits P1)

## [2.60.45] — 2026-07-10

### Fixed

- **cli:** Don't false-kill a turn on a long silent tool (yarn install idle timeout)

## [2.60.44] — 2026-07-10

### Fixed

- **cli:** Recover ACP adapter install-race crashes structurally, not by error-code list

## [2.60.43] — 2026-07-10

### Fixed

- **cli:** Keep relay daemon alive on stray unhandled rejection

## [2.60.42] — 2026-07-10

### Added

- **cli:** CodeRabbit 'provision' action — restore the vaulted credential, no re-login

## [2.60.41] — 2026-07-10

### Fixed

- **cli:** Surface a clean error when a CodeRabbit review times out

## [2.60.40] — 2026-07-10

### Added

- **cli:** Include changed files (git numstat) in the CodeRabbit review result

## [2.60.39] — 2026-07-10

### Fixed

- **cli:** Emit an 'installing' phase on first CodeRabbit link

## [2.60.38] — 2026-07-10

### Fixed

- **cli:** Time-bound CodeRabbit one-shot so a hung review can't wedge the relay
- **cli:** Parse real CodeRabbit --agent findings; never dump raw NDJSON

## [2.60.37] — 2026-07-10

### Fixed

- **cli:** Time-bound CodeRabbit one-shot so a hung review can't wedge the relay

## [2.60.36] — 2026-07-10

### Fixed

- **cli:** CodeRabbit link must preserve the session (it rides the live session)

## [2.60.35] — 2026-07-10

### Fixed

- **cli:** CodeRabbit OAuth works headless (codespace/self-hosted) via a PTY + stdin token

## [2.60.34] — 2026-07-10

### Added

- **cli:** CodeRabbit session-relay OAuth — deliver mobile-intercepted redirect to host loopback

## [2.60.33] — 2026-07-10

### Fixed

- **cli:** Pre-accept Claude's per-workspace trust dialog on cloud sessions

## [2.60.32] — 2026-07-10

### Fixed

- **cli:** Retry ACP adapter start on a module-load crash (ERR_MODULE_NOT_FOUND)

## [2.60.31] — 2026-07-10

### Tests

- **cli:** Fix kimi-config-provision (login removed) + stabilize Windows waitForBinary

## [2.60.29] — 2026-07-10

### Added

- **shared:** Add CODERABBIT_* to USER_EVENTS (fix A↔B shared-drift)

### Fixed

- **cli:** Route "Authentication required" to the re-auth bubble (kimi codespace)

## [2.60.28] — 2026-07-09

### Fixed

- **cli:** Coderabbit — don't emit status snapshot on review (clobbered linked)

## [2.60.27] — 2026-07-09

### Added

- **shared:** CodeRabbit links via oauth_token (loopback) — vault gate

### Fixed

- **cli:** Coderabbit — augment PATH before findInPath (session reported not-linked)
- **cli:** Coderabbit PATH augment is platform-aware (Windows/WSL too)

## [2.60.26] — 2026-07-09

### Added

- **shared:** CodeRabbit links via oauth_token (loopback) — vault gate

### Fixed

- **cli:** Kimi — provision config.toml on self-hosted (Windows-safe), fixing "Model: not set"

## [2.60.25] — 2026-07-09

### Fixed

- **cli:** Kimi — provision config.toml on self-hosted (Windows-safe), fixing "Model: not set"

## [2.60.24] — 2026-07-09

### Added

- **cli:** Coderabbit reviewer — link (OAuth + API key) + review relay wiring

### Fixed

- **cli:** Show OS-correct install hint for kimi/cursor on Windows

## [2.60.23] — 2026-07-09

### Added

- **cli:** Coderabbit — OAuth login capture core (Phase 1)

### Fixed

- **cli:** Coderabbit — rewrite batch strategy against the REAL CLI surface
- **cli:** Coderabbit — parser handles the REAL --agent NDJSON control + error events
- **cli:** Cursor baton — mint create-chat via os.buildLaunch (Windows spawn fix)

## [2.60.22] — 2026-07-09

### Fixed

- **cli:** Baton — late-bind Codex's session id instead of blocking start()

## [2.60.21] — 2026-07-09

### Fixed

- **cli:** Baton — discover Codex's self-minted session id (first-turn aware)

## [2.60.20] — 2026-07-09

### Fixed

- **cli:** Baton — pre-mint Cursor session id via `create-chat`
- **cli:** Baton Take Control for Cursor — bridge native↔ACP session stores

## [2.60.19] — 2026-07-09

### Fixed

- **cli:** Baton — pre-mint Cursor session id via `create-chat`

### Tests

- **cli:** De-flake adapter module-graph gate — crash synchronously in settling fixture

## [2.60.18] — 2026-07-09

### Added

- **cli:** Auto-install Kimi on local pair when the binary is missing

### Fixed

- **cli:** Baton — discover Kimi's self-minted session id after spawn

## [2.60.17] — 2026-07-09

### Added

- **cli:** Auto-install Kimi on local pair when the binary is missing

## [2.60.16] — 2026-07-09

### Added

- **cli:** Session Baton support for Kimi Code (local Take Control)

## [2.60.15] — 2026-07-09

### Fixed

- **cli:** Write Kimi OAuth login-state to the real credentials path

## [2.60.14] — 2026-07-08

### Added

- **cli:** Add Kimi Code (Moonshot) as a native ACP agent

## [2.60.13] — 2026-07-08

### Fixed

- **cli:** Pair-auto must never be a local/baton session (agent_banner regression)

## [2.60.12] — 2026-07-08

### Fixed

- **cli:** Local self-update relaunch orphaned the interactive session

## [2.60.11] — 2026-07-08

### Fixed

- P0/P1 batch — pricing default, headroom step export, VSC listener dedup, JB EDT delay

## [2.60.10] — 2026-07-08

### Added

- **cli:** Detailed observability for the gemini baton paths

## [2.60.9] — 2026-07-08

### Added

- **cli:** Baton support for gemini (native-TUI mirror + resume)

## [2.60.8] — 2026-07-08

### Fixed

- **cli:** Codex baton mirror — parse the current flat rollout format

## [2.60.7] — 2026-07-08

### Fixed

- **cli:** Retry ACP start on the adapter's transient in-binary spawn ETXTBSY

## [2.60.6] — 2026-07-08

### Fixed

- **cli:** Serialize ACP prompts so a 2nd in-flight turn can't clobber the watchdog

## [2.60.5] — 2026-07-08

### Added

- **cli:** Baton support for cursor + gate to agents with a resumable transcript

### Documentation

- **cli:** Document the Session Baton (native TUI <-> mobile ACP) architecture + hand-off invariants

### Fixed

- **cli:** Serialize baton state POSTs so handback never sticks on "Switching…"

## [2.60.4] — 2026-07-08

### Fixed

- **cli:** Serialize baton state POSTs so handback never sticks on "Switching…"

## [2.60.3] — 2026-07-08

### Fixed

- **cli:** Clean up terminal + mobile activity on baton Take Control

## [2.60.2] — 2026-07-08

### Fixed

- **cli:** Baton mirror waits for the jsonl, pushes full snapshot, live-publishes every turn

## [2.60.1] — 2026-07-08

### Chore

- **cli:** Remove CODEAM_BATON flag — baton unconditional for local sessions

### Fixed

- **cli:** Baton LOCAL_DRIVE mirror publishes turns live via the output stream

## [2.60.0] — 2026-07-08

### Added

- **cli:** Baton local-session gate + feature flag
- **cli:** BatonController turn-safe single-driver state machine
- **cli:** TranscriptMirror emits JSONL deltas for the read-only view
- **cli:** NativeTuiDriver over AgentService with idle turn-boundary
- **cli:** AcpDriver over AcpClient (spawn + loadSession resume)
- **cli:** PostBatonEvent publisher driver-state
- **cli:** Take_control/handback relay handlers
- **cli:** Wire local baton branch before the ACP fork (flag-gated)
- **cli:** Make the session baton drivable after a hand-off
- **cli:** Enable the session baton by default for local sessions (CODEAM_BATON=0 kill switch)
- **shared:** Add baton_state to USER_EVENTS (session baton wire type)

### Changed

- **cli:** Extract shared ACP command-context assembler + proxy-relaunch helper

### Fixed

- **cli:** Mark SessionDriver.kind readonly (contract)
- **cli:** Baton switch-failure recovery + ack-on-failure; test cleanups
- **cli:** EncodeCwd underscore-collapse + ClaudeRuntimeStrategy.resolveHistoryFile (baton mirror)
- **cli:** AcpClient.start cleans up on handshake failure (baton take-control recovery)

### Tests

- **cli:** Prove noteOutput resets the idle window + cover throw/undefined branches
- **cli:** Gated cross-mode-resume integration test (real claude)

## [2.59.0] — 2026-07-08

### Added

- **vsc-plugin:** Route stop_task through AgentStrategyRegistry, alias escape_key
- **vsc-plugin:** CopilotLmStrategy.stop() cancels the active LM stream
- **jetbrains-plugin:** Alias escape_key to stop_task
- **jetbrains-plugin:** Best-effort surface-interrupt helper for GUI agents
- **jetbrains-plugin:** Concrete strategies interrupt their surface on stop()

### Tests

- **cli:** Regression-guard stopTaskH cancels ACP turn and acks once

## [2.58.1] — 2026-07-08

### CI

- **workflow:** Add win32-native cursor-agent PATH resolution gate

### Fixed

- **cli:** Resolve cursor-agent by absolute path on Windows (stale-PATH ENOENT)

## [2.58.0] — 2026-07-07

### CI

- Knip dead-code gate (blocking) for repo B + delete grep-verified dead code (codeagent-nvt)

### Changed

- **cli:** Quiet.ts best-effort helpers + merge util dirs into lib/ (codeagent-nvt)

## [2.57.0] — 2026-07-07

### Changed

- **cli:** Registry-drive per-agent branches, remove dead 1M-recovery, split HandlerContext (codeagent-tok)

## [2.56.0] — 2026-07-07

### Changed

- **cli:** Runner.ts dispatch table — AcpCommandContext replaces the 19-param handleCommand (Phase 3)
- **cli:** Split host-agent.ts into commands/host/ modules + one spawnHeadroomProxy (Phase 3)
- **cli:** Decompose previewStartH into stages + event-driven tunnel wait (Phase 3 wave 2)

## [2.55.1] — 2026-07-07

## [2.54.0] — 2026-07-06

### Added

- **shared:** Rename to @codeam/shared and make it publishable to npm (Phase 2 PR-0)
- **shared:** Agent capability flags + identity module + headroom manifest + beads superset (Phase 2 PR-1)

### Fixed

- **cli:** Windows CI green — derive claude exe suffix from platformKey; win32-native install-target expectations
- **cli:** Self-update can actually spawn npm on Windows — shell for the .cmd shim

## [2.53.4] — 2026-07-06

### Fixed

- **jetbrains:** Eliminate all 8 internal-API usages flagged by Plugin Verifier
- **shared:** Phase 1 anti-drift — sync wire contracts, USER_EVENTS constants, zod RemoteCommand guard, JB respondWith + drift tests

### Tests

- **cli:** Backend contract fixtures for beads_action + migrate off deprecated BeadsActionPayload alias

## [2.53.3] — 2026-07-06

### Fixed

- Phase 0 hygiene — 8 verified bugs across cli/shared/vsc/jetbrains

## [2.53.2] — 2026-07-06

### Fixed

- **ci:** Remove agent auto-approve+merge of externally-sourced PRs (SEC critical) ⚠️ BREAKING CHANGE
- **cli:** Skip savings reporter without plugin-auth token + reconnect-subscription recovery for 1M-credits gate

## [2.53.1] — 2026-07-06

### Fixed

- **cli:** Gate ACP adapter spawn on its JS module graph, not just its binary

## [2.53.0] — 2026-07-06

### Added

- **cli:** Proactive credential validation on session start / wake

## [2.52.12] — 2026-07-05

### Fixed

- **cli:** Supervise the Headroom proxy + report version on heartbeat

## [2.52.11] — 2026-07-04

### Fixed

- **cli:** Don't report a Windows Ctrl+C / console-close as an adapter crash

## [2.52.10] — 2026-07-04

### Fixed

- **cli:** Self-update installs into the RUNNING prefix — no more manual-update fallback

## [2.52.9] — 2026-07-04

### Fixed

- **cli:** SDK dir resolution vs exports map — gate no longer burns 240s per start

## [2.52.8] — 2026-07-03

### Changed

- **cli:** Each ACP agent owns its launch-binary readiness check

## [2.52.7] — 2026-07-03

### Fixed

- **cli:** Wait for Claude native binary before spawning the agent in codespaces

## [2.52.6] — 2026-07-03

### Fixed

- **cli:** An invalid pairing latches the output pipeline — no more silent dead-token spam

## [2.52.5] — 2026-07-02

### CI

- **workflow:** Free runner disk before the JetBrains publish job

## [2.52.3] — 2026-06-30

### Added

- **cli:** Emit static quick-reply chips from ACP runner on normal turn end

## [2.52.2] — 2026-06-30

### Fixed

- **acp:** Stop synthesising input_suggestion from the reply (echoed agent msg)

## [2.52.1] — 2026-06-29

### Fixed

- **cli:** Send ideVersion on reconnect to keep session version current

## [2.52.0] — 2026-06-29

### Added

- **cli:** Add cli_self_update relay command handler (tap-to-update)

### Fixed

- **cli:** Treat codespace as no-self-relaunch in cli_self_update

## [2.51.3] — 2026-06-29

### Fixed

- **cli:** Stop retrying on terminal enroll-token 4xx (ENROLL_TOKEN_EXPIRED / ENROLL_TOKEN_INVALID)

## [2.51.2] — 2026-06-29

### Fixed

- **headroom:** Route budget relaunch through supervisor when headroom install is active

## [2.51.1] — 2026-06-29

### Fixed

- **cli:** Cross-platform owner-only file protection (Windows icacls)
- **cli:** Make restrictToOwner best-effort on POSIX too

### Tests

- **cli:** Guard 0600 mode assertion in beads config-store for Windows

## [2.51.0] — 2026-06-29

### Added

- **shared:** Add Headroom budget types and command interface
- **cli:** Add Headroom proxy --budget arg builder + wire into spawn sites
- **cli:** Headroom_budget relay handler (relaunch proxy with budget)
- **cli:** Report period spend/budget from headroom /stats
- **cli:** Detect Headroom budget-exceeded 429, offer pause/raise recovery

### Fixed

- **cli:** Persist headroom budget fields in headroom-config.json for self-hosted durability
- **cli:** Offer() receives combined haystack + fire-once budget POST test
- **cli:** Clear HEADROOM_BUDGET env from relaunch proxy env (pause clears budget cap)

### Tests

- **cli:** Gated real headroom budget integration

## [2.50.0] — 2026-06-28

### Added

- **cli:** Persisted beads-config.json (default-on disable flag)
- **cli:** Honor persisted beads disable flag in provisionBeadsForStart
- **cli:** ConfigureBeads enable/disable/status service
- **cli:** Beads_configure command handler + event emitter
- **cli:** Emit input_suggestion chip on ACP agent path after closing question

### Fixed

- **cli:** Status honors persisted disable flag; drop beads handler cast
- **cli:** Make beads_configure status probe read-only (no provisioning)

### Tests

- **cli:** Gated beads_configure integration smoke
- **cli:** Import vitest globals in beads test files (fix typecheck)

## [2.49.5] — 2026-06-28

### Fixed

- **cli:** Credit on-demand local Headroom savings to the backend

## [2.49.4] — 2026-06-27

### Fixed

- **cli:** Serialize Headroom SSE event POSTs to preserve emit order

## [2.49.3] — 2026-06-27

### Fixed

- **cli:** Resolve a Python ≥3.10 for Headroom install (avoid macOS Xcode py3.9)
- **cli:** Auto-install Python ≥3.10 for Headroom when none present
- **cli:** Capture stdout in headroom runner so the python ≥3.10 probe works
- **cli:** Require pip in the headroom python probe (skip pip-less newest python)

## [2.49.2] — 2026-06-27

### Fixed

- **cli:** Set agentId in ACP HandlerContext so headroom enable works for claude/codex

## [2.49.1] — 2026-06-27

### Fixed

- **cli:** Resolve headroom agent from running session, not just payload

## [2.49.0] — 2026-06-27

### Added

- **cli:** Parameterize setupHeadroomForSelfHosted (extras + progress + config backup)
- **cli:** Headroom_configure handler + configure service + postHeadroomEvent

### Fixed

- **cli:** Widen sendResult to unknown (drop unsafe casts) + guard agentId + unref stopProxy
- **cli:** Persistent-container disable phase + validated casts + exclude test driver
- **cli:** Headroom stopProxy survives missing pkill + procps in int-test image
- **cli:** Surface driver errors + bake headroom deps into int-test image
- **workflow:** Reuse prebuilt headroom image in int test + apt retry (no double build)

### Tests

- **cli:** Real Docker integration test for Headroom on-demand enable/disable

## [2.48.1] — 2026-06-26

### Fixed

- **cli:** Actionable failure bubble replaces streamed raw 401 instead of appending below it

## [2.48.0] — 2026-06-26

### Added

- **shared:** EnvVar wire type for env-config
- **cli:** Dotenv parse/serialize util for env-config
- **cli:** Accept env-config vars[] in startCommandSchema
- **cli:** Env_read handler
- **cli:** Env_write handler (validate + atomic write)
- **cli:** Preview_restart handler (kill + re-spawn from stored detection)

### Changed

- **cli:** Store detection on ActivePreview + extract startPreviewFromDetection

## [2.47.1] — 2026-06-26

### Chore

- **plugins:** Cloud-fallback follow-ups — test await, validated narrowing, repoSlug+learnMoreUrl tests, path-preserving probe URL, detached-HEAD parity, drop vestigial param (#393)

## [2.47.0] — 2026-06-26

### Added

- **vsc-plugin:** API reachability preflight (checkApiReachable)
- **vsc-plugin:** DetectRepoSlug from the origin git remote
- **vsc-plugin:** Cloud-fallback message content builder
- **vsc-plugin:** Show cloud fallback when the API is unreachable during pairing
- **jetbrains-plugin:** API reachability + repo slug + cloud-fallback content
- **jetbrains-plugin:** Show cloud fallback when the API is unreachable during pairing

### Fixed

- **jetbrains-plugin:** Run repo-context git calls off the EDT in the cloud-fallback branch
- **jetbrains-plugin:** Show cloud-fallback panel on the tool-window Generate button (parity with VS Code)

## [2.46.6] — 2026-06-26

### Fixed

- **cli:** Mint a fresh beads DB when the remote has no Dolt data (bootstrap-then-mint)

## [2.46.5] — 2026-06-26

### Fixed

- **cli:** Collapse thinking onto a per-turn buffer so the activity card doesn't double
- **cli:** Verify + self-heal the project Dolt DB after provisioning (codeagent-ckq)

## [2.46.4] — 2026-06-26

### Fixed

- **cli:** Retry + poll dolt sql-server start so it's up before the agent (codeagent-r5k)

## [2.46.3] — 2026-06-26

### Added

- **cli:** Detect Cursor plan paywall reply → actionable upgrade-link bubble

## [2.46.2] — 2026-06-26

### Added

- **cli:** Cursor generateOneShot → enables Preview detection + AI summaries

## [2.46.1] — 2026-06-26

### Fixed

- **cli:** Write cursor OAuth credential to login state, not CURSOR_API_KEY

## [2.46.0] — 2026-06-26

### Fixed

- **cli:** Route cursor over native ACP (cursor-agent acp) so CURSOR_API_KEY reaches it

## [2.45.1] — 2026-06-25

### Fixed

- **cli:** Map cursor to its own Headroom kind (self-hosted launched Claude)
- **cli:** Disable Headroom for unsupported agents (gemini ran as Claude)

### Tests

- **cli:** Stub gh-tooling network ops in cloneToken deploy test (fix windows flake)

## [2.45.0] — 2026-06-25

### Added

- **cli:** Cursor self-hosted provisioning (CURSOR_API_KEY)

## [2.44.0] — 2026-06-25

### Added

- **cli:** Codeam invite — print referral link

## [2.43.7] — 2026-06-25

### Fixed

- **cli:** Surface ACP agent startup failures in-app instead of stuck loading/offline

## [2.43.6] — 2026-06-25

### Fixed

- **cli:** ACP newSession no longer hangs forever on a fatal startup error

## [2.43.5] — 2026-06-25

### Added

- **cli:** Self-hosted provisioning for Gemini credentials

## [2.43.4] — 2026-06-25

### Fixed

- **cli:** Codex conversation resume loads the transcript (per-agent history)

## [2.43.3] — 2026-06-25

### Fixed

- **cli:** Codex can reach the Beads/Dolt socket in the autonomous plane

## [2.43.2] — 2026-06-25

### Fixed

- **cli:** Self-hosted credential cleanup on authType change (claude + codex)
- **cli:** Welcome CTA shows the repo name, not the session UUID

## [2.43.1] — 2026-06-24

### Fixed

- **cli:** 1M-context recovery must publish an awaiting-answer (the tappable button), not just a select_prompt chunk

## [2.43.0] — 2026-06-24

### Added

- **cli:** Classify the 1M-context usage-credits error
- **cli:** Persist per-session disable1mContext flag
- **cli:** AcpClient accepts extraEnv for the adapter spawn
- **cli:** OneMContextRecovery offer + decision helper
- **cli:** OneMContextRecovery offer + decision helper + DI recovery factory
- **cli:** On-demand 1M-context disable recovery — offer action, re-spawn ACP with the knob, auto-rerun

### Changed

- **cli:** Move 1M-context classifier into oneMContextRecovery (break runner import cycle)

### Documentation

- **meta:** Record agent-failure-messaging + heartbeat + credential rules (AGENTS.md + CLAUDE.md)

## [2.42.0] — 2026-06-24

### Added

- **cli:** Confirm provider outage via status page on turn stall/failure (catch-all)

### Fixed

- **cli:** Make agent-failure messaging honest — outage only on real provider error, re-auth on auth-notice replies
- **cli:** Keep the heartbeat punctual by detecting the git branch off the hot path

## [2.41.0] — 2026-06-24

### Added

- **cli:** Surface friendly provider-outage message + status-page link instead of silent hang

### Merge

- Friendly provider-outage message + status-page link (no silent hang on provider 529/5xx)

## [2.40.2] — 2026-06-24

### Fixed

- **cli:** Provision Claude setup-token via CLAUDE_CODE_OAUTH_TOKEN on self-hosted (was malformed .credentials.json → 401)

### Merge

- Provision Claude setup-token via CLAUDE_CODE_OAUTH_TOKEN on self-hosted

## [2.40.1] — 2026-06-24

### Fixed

- **cli:** Refresh plugin-auth token on 401 in reportCredentialInvalid

### Merge

- ReportCredentialInvalid refreshes plugin-auth token on 401 (codeagent-niu)

## [2.40.0] — 2026-06-24

### Added

- **cli:** Add formatAgentReplyLine for the pair full-thread echo
- **cli:** Echo agent reply in codeam pair so the full thread is visible

### Fixed

- **cli:** Refresh plugin-auth token and retry once on 401/403 output POST
- **cli:** Wire plugin-auth token refresh into ACP publisher
- **cli:** Await bounded terminal-frame flush before adapter-exit teardown

### Merge

- Session-hang CLI fix (token self-heal + flush-before-exit) + codeam pair agent-reply echo

## [2.39.87] — 2026-06-23

### Added

- **cli:** Link Claude via setup-token (dedicated non-rotating codespace credential)

## [2.39.86] — 2026-06-23

### Fixed

- **cli:** Report credential-invalid on mid-turn auth 401, not just adapter exit

### Tests

- **cli:** Reproduce-first guard for self-hosted house-agent 401

## [2.39.85] — 2026-06-23

### Fixed

- **cli:** Isolate house agent's Claude config on self-hosted boxes

## [2.39.84] — 2026-06-22

### Added

- **cli:** Agent-agnostic credential validation in codeam link

### Fixed

- **cli:** Make self-hosted git credential helper + gh install OS-agnostic

## [2.39.83] — 2026-06-22

### Added

- **cli:** Install + authenticate gh on bare self-hosted boxes
- **cli:** Synchronous auto-upgrade for link/pair on stale CLIs

### Fixed

- **cli:** Persist git credentials + commit identity for self-hosted workspaces

## [2.39.82] — 2026-06-22

### Fixed

- **cli:** Upload the ACP transcript on get_conversation so truncated turns heal (incremental, scalable)

## [2.39.81] — 2026-06-22

### Fixed

- **cli:** Always publish a visible terminal frame on a failed turn (no more silent first message)
- **cli:** Namespace streaming-chunk ids per turn so thinking/tool chips keep rendering

## [2.39.80] — 2026-06-22

### Added

- **cli:** Report Headroom's authoritative compression savings (not prompt-cache)

### Fixed

- **cli:** Always publish a visible terminal frame on a failed turn (no more silent first message)

## [2.39.79] — 2026-06-22

### Added

- **cli:** Report Headroom's authoritative compression savings (not prompt-cache)

### Fixed

- **cli:** Keep Headroom savings reporting on a low-disk box that's already installed

## [2.39.78] — 2026-06-21

### Fixed

- **cli:** Keep Headroom savings reporting on a low-disk box that's already installed

## [2.39.77] — 2026-06-21

### Added

- **cli:** Report runtime 401 to mark the credential invalid

## [2.39.76] — 2026-06-21

### Added

- **cli:** Report compression-$ savings (eliminated tokens × model input price)

### Fixed

- **cli:** Smoke probe /health not /api/health

## [2.39.75] — 2026-06-21

### Fixed

- **cli:** Render pairing code + QR on stderr, not stdout (fixes #356)

## [2.39.74] — 2026-06-21

### Fixed

- **cli:** Preview no longer dies silently on string setup_commands

## [2.39.73] — 2026-06-21

### Fixed

- **cli:** Self-hosted Headroom Kompress on ONNX (no torch) + model pre-download

## [2.39.72] — 2026-06-21

### Fixed

- **host-agent:** Validate torch before enabling Kompress (never hang the proxy)

## [2.39.71] — 2026-06-21

### Tests

- **host-agent:** Drop the real-subprocess Headroom test (downloaded PyTorch in CI)

## [2.39.69] — 2026-06-21

### Added

- **cli:** Report Headroom prompt-cache savings, not just compression

### Fixed

- **cli:** Make the pairing code more legible (letter-spacing + bold + contrast)

## [2.39.68] — 2026-06-20

### Tests

- **host-agent:** Don't leak a heartbeat timer in the self_hosted_stop test

## [2.39.66] — 2026-06-20

### Fixed

- **cli:** Kill preview dev-server process group to stop port leaks (EADDRINUSE)

## [2.39.65] — 2026-06-20

### Added

- **self-hosted:** Run sessions in AUTO mode (auto-approve permissions)

## [2.39.64] — 2026-06-20

### Added

- **host-agent:** Handle self_hosted_refresh_credentials (in-place re-auth)

## [2.39.63] — 2026-06-20

### Added

- **acp:** Make the auth-fail message's re-auth a tappable deep-link

## [2.39.62] — 2026-06-20

### Fixed

- **acp:** Re-seed the welcome into history on resume so a later flush can't drop it

## [2.39.61] — 2026-06-20

### Fixed

- **acp:** Persist the 401 re-auth message in the durable conversation

## [2.39.60] — 2026-06-20

### Fixed

- **acp:** Surface a persistent re-auth message when a turn fails on 401

## [2.39.59] — 2026-06-20

### Fixed

- **host-agent:** Resolve bundled claude via fs walk, not exports-blocked require

## [2.39.58] — 2026-06-20

### Added

- **host-agent:** Event-driven session lifecycle (off the heartbeat)

### Fixed

- **host-agent:** Put SDK-bundled claude on PATH for `headroom init`

## [2.39.57] — 2026-06-20

### Added

- **host-agent:** Event-driven session lifecycle (off the heartbeat)

## [2.39.56] — 2026-06-20

### Added

- **cli:** Report supervised sessions in self-hosted heartbeat

## [2.39.55] — 2026-06-20

### Added

- **cli:** Self-hosted host-agent auto-update + persistent headroom env

## [2.39.54] — 2026-06-20

### Fixed

- **cli:** Map agent id to headroom init kind on self-hosted (claude_code → claude)

## [2.39.53] — 2026-06-20

### Added

- **cli:** Self-hosted headroom auto-provisions a bare environment

## [2.39.52] — 2026-06-20

### Added

- **cli:** Set up Headroom on self-hosted deploys

## [2.39.51] — 2026-06-20

### Fixed

- **cli:** Reuse running preview on re-open instead of re-spawn (EADDRINUSE)

## [2.39.50] — 2026-06-19

### Fixed

- **cli:** Parse real headroom /stats shape so savings reach the dashboard

## [2.39.49] — 2026-06-19

### Fixed

- **cli:** Load codespace-env.json + start savings reporter on serving daemon

## [2.39.48] — 2026-06-19

### Fixed

- **cli:** Per-session daemon singleton — stop duplicate codeam daemons

## [2.39.47] — 2026-06-19

### Fixed

- **cli:** Skip headroom reporter when pluginAuthToken absent; alias-tolerant stats mapping

## [2.39.46] — 2026-06-19

### Added

- **cli:** Wrap codespace agent launch with headroom (never-break fallback)
- **cli:** Headroom /stats poll reporter (local, scoped) -> backend savings
- **cli:** Start/stop headroom savings reporter with the codespace agent

## [2.39.45] — 2026-06-19

### Fixed

- **cli:** Fetch pluginAuthToken via /api/pairing/reconnect when PoP enforcement omits it from pair_completed

### Tests

- **cli:** Make untracked-path assertion platform-agnostic (fix Windows CI)

## [2.39.44] — 2026-06-19

### Fixed

- **cli:** Surface untracked new files with real line counts in changeset

## [2.39.43] — 2026-06-19

### Fixed

- **cli:** Extract macOS cloudflared .tgz + self-heal gzip-corrupt cache

## [2.39.42] — 2026-06-19

### Added

- **cli:** Refuse preview + notify app when the detected port is in use

## [2.39.41] — 2026-06-19

### Fixed

- **cli:** Install yarn on demand when a yarn project lacks it

## [2.39.40] — 2026-06-19

### Added

- **cli:** Run named preview tunnel via token, fallback to quick tunnel

## [2.39.39] — 2026-06-19

### Fixed

- **cli:** Gate preview tunnel on cloudflared 'Registered tunnel connection', not a host DNS probe

## [2.39.38] — 2026-06-19

### Added

- **cli:** Host-agent runs the per-agent install script before spawning

## [2.39.37] — 2026-06-19

### Fixed

- **cli:** Preview always uses cloudflared + auto-retries the tunnel

## [2.39.36] — 2026-06-18

### Fixed

- **cli:** Preview dev-server run command rewrites pnpm/bun → npm run

## [2.39.35] — 2026-06-18

### Fixed

- **cli:** Preview pre-flight installs with npm --legacy-peer-deps (not pnpm)

### Tests

- **cli:** Integration regression for ACP reply-doubling (notification → mapper → runner)

## [2.39.34] — 2026-06-18

### Fixed

- **cli:** Collapse all turn text onto one chunk so the reply can't double
- **cli:** Backfill $HOME so Beads provisioning works on detached self-hosted boxes

## [2.39.32] — 2026-06-18

### Fixed

- **cli:** Host-agent deploy clones private repos + reports progress, no silent hang

## [2.39.31] — 2026-06-18

### Fixed

- **cli:** Host-agent re-enrollment + self-heal on deleted host

## [2.39.30] — 2026-06-18

### Added

- **cli:** Report real system metrics in host-agent heartbeat

## [2.39.29] — 2026-06-18

### Added

- **cli:** Report host-agent enrollment progress to backend

## [2.39.28] — 2026-06-18

### Added

- **cli,vsc-plugin,jetbrains-plugin:** Add show_install_command relay handler (#355)

## [2.39.27] — 2026-06-17

### Added

- **cli:** Run the managed house agent on self-hosted host deploys (#330) (#353)

### Chore

- **deps:** Bump ACP adapters + resync lockfile (supersedes #324, #325) (#352)

## [2.39.26] — 2026-06-17

### Documentation

- **cli:** Document the self-hosted execution plane in the npm README (#351)

## [2.39.25] — 2026-06-17

### Added

- **cli:** Self-hosted host-agent supervisor + Docker E2E (#330) (#350)

## [2.39.24] — 2026-06-17

### Changed

- **cli:** Make claude/codex ACP-only; drop legacy PTY parsers + acpDisabled (#349)

## [2.39.23] — 2026-06-17

### Chore

- **cli:** Raise engines.node floor to >=20, bump which to ^6 (#345)

### Agent

- Waiting for your CLI... (#348)

## [2.39.22] — 2026-06-16

### Fixed

- **cli:** Stop the onboarding turn from wiping the welcome banner card (#344)

## [2.39.21] — 2026-06-16

### Fixed

- **cli:** Serialize onboarding welcome before the command relay starts (#343)

## [2.39.20] — 2026-06-15

### Fixed

- **cli:** Handle ACP adapter spawn errors instead of crashing the relay

## [2.39.19] — 2026-06-15

### Fixed

- **cli:** Capture a larger preview dev-server log so the real failure surfaces

## [2.39.18] — 2026-06-14

### Added

- **cli:** Send X-Plugin-Auth-Token on conversation-history writes (SEC crit1 #819) — v2.39.18

## [2.39.16] — 2026-06-14

### Added

- **jetbrains-plugin:** Proof-of-possession secret for /status + /reconnect (SEC crit1)

## [2.39.15] — 2026-06-14

### Added

- **vsc-plugin:** Proof-of-possession secret for /status + /reconnect (SEC crit1)

## [2.39.14] — 2026-06-14

### Added

- **cli:** Proof-of-possession secret for the auto-pair / codespace flow (SEC crit1)

## [2.39.13] — 2026-06-14

### Added

- **cli:** Proof-of-possession secret for /status + /reconnect (SEC crit1)

## [2.39.12] — 2026-06-13

### Fixed

- **vsc-plugin,jetbrains-plugin:** Auto-reconnect the last session on IDE startup

## [2.39.11] — 2026-06-13

### Fixed

- **cli:** Never let PostHog telemetry crash or spam the CLI session

### Tests

- **cli:** Fix Windows-only watcher path assertion (cross-platform path.join)
- **cli:** Import only join from path in the watcher test

## [2.39.10] — 2026-06-13

### Fixed

- **cli:** Pre-complete Claude onboarding + persist on-demand preview detect

## [2.39.9] — 2026-06-13

### Added

- **cli:** Auto-provision project deps (docker compose) gated before the agent

## [2.39.8] — 2026-06-13

### Fixed

- **cli:** Beads watcher trigger — watch .beads/last-touched + initial push

## [2.39.7] — 2026-06-13

### Fixed

- **cli:** Hardcode the onboarding welcome (no agent round-trip) + keep beads gate

## [2.39.6] — 2026-06-13

### Fixed

- **cli:** Gate agent spawn on beads in codespaces so the SessionStart hook lands

## [2.39.5] — 2026-06-13

### Fixed

- **cli:** Retry transient bd spawn ETXTBSY (not just ENOENT) so beads provisions
- **cli:** Link bd into ~/.local/bin, not the transient /tmp node prefix

## [2.39.4] — 2026-06-12

### Fixed

- **cli:** Retry transient bd spawn ETXTBSY (not just ENOENT) so beads provisions

## [2.39.3] — 2026-06-12

### Fixed

- **cli:** Singleton guard for pair-auto — prevent split-brain sessions (codeagent-qi4)

## [2.39.2] — 2026-06-12

### Added

- **cli:** Pre-warm preview detection so the first Start Preview is instant

## [2.39.1] — 2026-06-12

### Fixed

- **cli:** Disable in-session auto-provision — it starved/killed sessions ⚠️ BREAKING CHANGE

## [2.39.0] — 2026-06-12

### Added

- **cli:** Auto-provision project dependencies in codespaces + preview_failed

### Fixed

- **cli:** Emit preview_error (not a new type) with stderr tail on dev-server failure

## [2.38.0] — 2026-06-12

### Added

- **cli:** Inherit team memories into the active repo's Beads DB (P3b)

### Chore

- **deps:** Bump com.squareup.okhttp3:okhttp in /apps/jetbrains-plugin (#326)
- **deps-dev:** Bump @vscode/test-electron from 2.5.2 to 3.0.0 in /apps/vsc-plugin (#322)

## [2.37.3] — 2026-06-11

### Fixed

- **cli:** Force full https:// URLs in onboarding welcome so both render as links

## [2.37.2] — 2026-06-11

### Added

- **cli:** Surface core features + collab channels in onboarding welcome

### Fixed

- **cli:** Persist ACP onboarding welcome to the conversation anchor

## [2.37.1] — 2026-06-11

### Fixed

- **cli:** Persist ACP onboarding welcome to the conversation anchor

## [2.37.0] — 2026-06-11

### Added

- **cli:** Agent sends a first onboarding welcome on a fresh pair

## [2.36.5] — 2026-06-11

### Fixed

- **cli:** Retry transient bd spawn ENOENT at the adapter (covers all calls)

## [2.36.4] — 2026-06-11

### Fixed

- **cli:** Retry bd setup on transient spawn ENOENT (postinstall race)

## [2.36.3] — 2026-06-11

### Fixed

- **cli:** AUTO mode in codespaces — auto-approve ACP permission requests

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

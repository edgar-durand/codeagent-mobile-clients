# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working inside this repository.

## Overview

This repo holds the **client-side pieces** of [CodeAgent Mobile](https://www.codeagent-mobile.com):

- `apps/cli` — `codeam-cli`, the Node.js CLI that spawns Claude Code under a PTY and relays mobile prompts. Published to npm.
- `apps/vsc-plugin` — The VS Code / Cursor / Windsurf extension. Published to VS Code Marketplace and Open VSX.
- `apps/jetbrains-plugin` — The IntelliJ-family plugin (IntelliJ IDEA, WebStorm, PyCharm, Rider, GoLand, …). Published to JetBrains Marketplace (stable channel) by the tag-triggered release workflow.
- `packages/shared` — `@codeam/shared`, pure-TypeScript modules (chunk-protocol parser, Anthropic pricing tables) bundled into the CLI and the VS Code extension at build time.

The backend, mobile app, and web dashboard are maintained elsewhere and are not in scope here.

## Repo layout

```
codeagent-mobile-clients/
├── apps/
│   ├── cli/                  # TypeScript · tsup · Vitest · Node ≥ 18
│   ├── vsc-plugin/           # TypeScript · esbuild · VS Code API
│   └── jetbrains-plugin/     # Kotlin · Gradle · JDK 17 · IntelliJ Platform
├── packages/
│   └── shared/               # @codeam/shared — pure TS, bundled at build time
├── .github/
│   ├── workflows/
│   │   ├── ci.yml            # commitlint + build + test on PR / push to main
│   │   └── release.yml       # tag-triggered publish pipeline
│   ├── ISSUE_TEMPLATE/       # bug report + feature request templates
│   ├── pull_request_template.md
│   ├── CODEOWNERS
│   └── dependabot.yml        # weekly npm + gradle + actions updates
├── cliff.toml                # git-cliff config (changelog generation)
├── commitlint.config.js      # Conventional Commits + allowed scopes
├── .gitmessage               # commit template
├── package.json              # npm workspaces root
├── .eslintrc.json, .prettierrc, .editorconfig, .nvmrc
├── CLAUDE.md (this file), CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md
└── README.md, LICENSE
```

All three clients ship **under one unified version line** starting at `2.0.0`. A single `vX.Y.Z` tag releases all of them together. **Current published version: `v2.10.8`** (May 2026).

## Commands

### Root

```bash
npm install                      # installs all workspaces (cli, vsc-plugin, shared)
npm run build:cli
npm run build:vsc-plugin
npm run build:jetbrains-plugin
npm run test:cli
npm run dev:cli
npm run publish:cli              # manual path; the workflow is preferred
npm run publish:vsc-plugin       # manual path
npm run publish:vsc-plugin:cursor
npm run reinstall:jetbrains-plugin  # dev helper — reinstalls into local WebStorm
npm run use-commit-template      # one-time: configure git to use .gitmessage
```

### Per app

```bash
# CLI
(cd apps/cli && npm run typecheck)
(cd apps/cli && npm run test)
(cd apps/cli && npm run build)
(cd apps/cli && npm run dev)      # tsup --watch

# VS Code plugin
(cd apps/vsc-plugin && npm run watch)   # esbuild --watch; F5 in VS Code to test
(cd apps/vsc-plugin && npm run build)   # production bundle
(cd apps/vsc-plugin && npx @vscode/vsce package --no-dependencies)

# JetBrains plugin
(cd apps/jetbrains-plugin && ./gradlew buildPlugin)
(cd apps/jetbrains-plugin && ./gradlew runIde)   # launches sandboxed IDE
```

## Architecture

### Data flow

```
┌─────────────────────┐   REST + SSE         ┌────────────────────┐
│  Mobile app / Web   │  ───────────────────▶│ CodeAgent backend  │
│  dashboard          │                       │                    │
└─────────────────────┘                       └─────────┬──────────┘
                                                        │ SSE pull (primary)
                                                        │ + HTTP polling (fallback)
                                                        ▼
                                              ┌────────────────────┐
                                              │ THIS REPO          │
                                              │ • codeam-cli       │
                                              │ • VS Code plugin   │
                                              │ • JetBrains plugin │
                                              └──────────┬─────────┘
                                                         │ PTY / IDE APIs
                                                         ▼
                                              ┌────────────────────┐
                                              │ Claude Code /      │
                                              │ Copilot / Cursor / │
                                              │ JetBrains AI …     │
                                              └────────────────────┘
```

### Command relay (clients ← backend)

All three clients (CLI, VS Code, JetBrains) implement the same two-mode command relay:

1. **SSE pull primary** — subscribe to `/api/commands/pending/stream?pluginId=…`. The backend `pushCommand` publishes a `commands` event; the client wakes within ~50 ms and dispatches the command. The backend caps SSE streams at a configured idle window and the client reconnects immediately (long-poll style).
2. **Polling fallback** — on two consecutive SSE failures (network blip, older backend without the stream endpoint, proxy stripping SSE), the client falls back to `GET /api/commands/pending` polling with **idle-streak backoff**: 2 s base, exponentially widening to ~32 s when consecutive polls return empty, reset to 2 s the moment a real command arrives.

Implementation shape is uniform across the three clients:

- CLI: `apps/cli/src/services/command-relay.service.ts`
- VS Code: `apps/vsc-plugin/src/services/command-relay.service.ts`
- JetBrains: `apps/jetbrains-plugin/src/main/kotlin/com/windsurf/controller/services/CommandRelayService.kt`

Auth header: `X-Plugin-Auth-Token` (the per-pairing secret returned at pair time) + `X-Codeam-Protocol-Version: 2.0.0`.

### No polling for realtime — non-negotiable

SSE (and the PTY data event on the CLI side) is the realtime channel for everything in this repo. **Do not introduce `setTimeout` / `setInterval` polling loops to detect state changes that already flow over an existing event stream.** This applies to chunk emission, suggestion detection, output settling — everything where a stream event is available.

Active examples to mirror:
- `OutputService.push(raw)` is the PTY data event handler. New idle-window detectors (input_suggestion, ready-prompt, etc.) **react inside `push()`** on the byte the PTY just delivered. They do NOT schedule `setTimeout` callbacks "to check again in 400 ms".
- `OutputService.tick()` runs at 1 s only while a turn is active and is the existing render-and-emit loop for accumulated PTY frames — not a polling escape hatch. Don't add new periodic checks alongside it; hook them into `push()` instead.
- The HTTP-polling fallback in `command-relay.service.ts` is the documented exception (older backends / proxies that strip SSE). New features must NOT add similar fallbacks "just in case".

If you find yourself reaching for `setTimeout` to "check again later", you're polling — stop and route the detection off the existing event instead.

### Shared package (`@codeam/shared`)

`packages/shared/src/` owns the *protocol contract* — the shapes, constants, and pure renderers the CLI and the VS Code extension must agree on byte-for-byte:

- `protocol/chrome-types.ts` — the protocol-level *shapes* (`ChromeToolType`, `ChromeStep`, `SelectPrompt`) for TUI chrome steps and interactive selectors. Types only — the parsers moved out (see below).
- `protocol/renderToLines.ts` — virtual terminal that turns raw PTY / shell-integration bytes into a clean array of screen lines. Handles CSI cursor moves, erase, alternate-screen, CR/LF quirks. Feeds every downstream parser.
- `protocol/constants.ts` — wire constants both clients embed (`PROTOCOL_VERSION`, `SSE_SOCKET_TIMEOUT_MS`, `OBSERVER_BRIDGE_PORT`, `HEARTBEAT_INTERVAL_MS_DEFAULT`).
- `protocol/remote-command.ts` — the `RemoteCommand` envelope (SSE `commands` frames + `/api/commands/pending` polling) with its zod schema and `toRemoteCommand(raw): RemoteCommand | null` validator. The VS Code relay uses it; the CLI's parse path is a follow-up.
- `models/pricing.ts` — Anthropic `MODEL_PRICING` and `MODEL_CONTEXT_WINDOW` tables plus `getPricing()` / `getContextWindow()` lookup helpers.
- `types/` — cross-repo wire types (`preview`, `beads`, `headroom`, `streaming`, `file-change`) plus `types/events.ts`: the `USER_EVENTS` constant map of every per-user SSE event name (canonical here; mirrored at `codeagent-mobile/packages/shared/src/types/events.ts`). New event-producing/consuming code references `USER_EVENTS.*`, never a hand-typed string.

⚠️ **The TUI chrome/selector *parsers* do NOT live in shared anymore** (old `protocol/parseChrome.ts` / `selector.ts` / `filterChrome.ts` are gone). Glyphs and conventions vary per agent, so each PTY agent owns its own fixture-driven parsers next to its runtime strategy: `apps/cli/src/agents/<agent>/parsing.ts` (e.g. `cursor/parsing.ts`, `aider/parsing.ts` — `parse<Agent>Chrome` / `filter<Agent>Chrome` / `detect<Agent>Selector`), consumed via the runtime strategy and `streaming-emitter.service.ts`. ACP agents (claude/codex/gemini) get typed streaming and need no chrome parsing. `apps/cli/src/services/parseChrome.ts` is a vestigial one-line re-export of `@codeam/shared` with no remaining importers — don't add logic there.

Tests live next to the modules in `packages/shared/__tests__/` and run via `(cd packages/shared && npm run test)` or are picked up by the CI job automatically.

**Critical rule:** when you touch the protocol contract (shapes, `renderToLines`, constants, `RemoteCommand`), pricing, or anything shared, change it *only* in `packages/shared`. Both consumers import through `@codeam/shared`. tsup (CLI) and esbuild (VS Code) inline the imports at build time so runtime consumers don't have a separate dependency. Per-agent parsing changes, by contrast, belong in that agent's `apps/cli/src/agents/<agent>/parsing.ts`.

JetBrains plugin is Kotlin and does **not** consume the shared package — if the same logic ever needs to exist there, port it deliberately and annotate the port.

### PTY handling (CLI)

`apps/cli/src/services/claude.service.ts` spawns Claude Code inside a Python PTY helper so Claude sees `stdin.isTTY === true` even when the CLI itself was launched from a non-TTY context. On Windows or when Python is unavailable it falls back to direct spawn.

**Critical: `select_option` handling.** When navigating a React Ink selector, arrow keys MUST be sent one at a time with ≥80 ms gaps. Sending all arrows in one write collapses into a single synchronous batch — React batches the state updates and Enter always picks option 0.

**Critical: parallel-Claude JSONL detection.** `apps/cli/src/services/history.service.ts` captures a `bootTimeMs` at construction and `detectCurrentConversation()` / `getCurrentUsage()` filter `~/.claude/projects/<cwd>/*.jsonl` entries by `birthtime >= bootTimeMs - 5 s grace`. Without this filter, if the user runs `codeam pair` in a directory where another Claude session is already chatting (common when developing this project itself), the actively-written JSONL of the parallel session wins the mtime sort and the CLI publishes the wrong conversation to the mobile app — bug fixed in `v2.10.8`. Similarly, `tryExtractSessionId` (in `OutputService`) only matches the unambiguous `Resuming session: <uuid>` pattern; the older broader `/Session:|/Conversation:` patterns matched incidental log lines and were dropped in the same fix.

### Agent-failure messaging — every failed turn ends with a HONEST, visible frame

`apps/cli/src/agents/acp/runner.ts` owns the contract that a turn NEVER ends silently or with a misleading status. Rules (each backed by `__tests__/agents/acp.failureBubble.test.ts`):

- **`failureBubble` is the SOLE arbiter of the failure bubble**, keyed on the agent's OWN error (`detail` / `recentStderr`): auth → re-auth bubble; `looksLikeProviderOutage` → outage bubble; non-auth/non-outage with no streamed text → generic retry; partial text already streamed → `null`.
- **The provider-outage bubble fires ONLY from the agent's error — NEVER from polling the provider status page.** A status-page incident can be live while the user's local agent is perfectly fine (partial/regional degradation, or a stale/unrelated advisory like a model suspension). The old `checkProviderStatus` status-page catch-all was removed for exactly this false-positive (`v2.42.0`). The status page is informational only — it's the link *inside* the bubble, not a trigger.
- **Auth notices that arrive as a COMPLETED-turn reply** (Claude prints `Not logged in · Please run /login` as plain text and ends cleanly — no throw, no exit) are caught by `replyIsAuthFailure` (length-guarded ≤200 chars so a reply that merely *discusses* login isn't misclassified) → swapped for the re-auth bubble + `reportCredentialInvalid`.
- **1M-context usage-credits gate → reconnect the subscription (`v2.43.0`, reworked).** claude Code v2.1.x ALWAYS sends the `anthropic-beta: …,context-1m-2025-08-07` header even when the account has `s1mAccessCache.hasAccess=false`; a credit-less account then 429s every turn with "Usage credits required for 1M context" (confirmed in the codespace's `~/.headroom/logs/proxy.log` — claude's inbound request carries the beta; Headroom forwards it unchanged, NOT its fault). Detected by `looksLike1mContextCreditsError`. **The original "Disable 1M context and continue" `select_prompt` recovery did NOT fix a credential-type credits gate (2026-06-24 incident)** — the account's credential simply lacks the entitlement. The recovery is now to **reconnect the Claude subscription via the in-app OAuth**: `failureBubble` classifies the 429 as `ONE_M_CREDITS_MESSAGE` (a `codeam://reauth` reconnect bubble) and the runner calls `reportCredentialInvalid` so Profile › Agents surfaces the reconnect CTA — identical to the auth-failure path. Both surfacing points are covered: the completed-turn-reply path and the thrown-error path. (The old `oneMContextRecovery.ts` disable/re-spawn DI factory is retained but no longer invoked — a candidate for removal.)

### Heartbeat must stay punctual — no synchronous work on the 20 s tick

`command-relay.service.ts`'s heartbeat is a `setInterval(20s)` in the SAME event loop as the ACP turn. It must do ZERO synchronous I/O: the git branch is seeded once at `start()` then refreshed via the async `detectCurrentBranchAsync` off the hot path (`v2.42.0`). A synchronous `execFileSync` on the tick couples the beat to git latency during a turn and can starve it (the "LAST PING —" stall).

### VS Code PTY

`apps/vsc-plugin/src/services/claude-pseudoterminal.ts` implements a custom `vscode.Pseudoterminal` backed by a `node-pty`-spawned `claude` process. `apps/vsc-plugin/src/services/terminal-agent.service.ts` waits for the `? for shortcuts` readiness marker before submitting the first prompt — a fixed-delay idle check drops the first prompt during Ink's initial render pause.

### Agent strategy pattern (VS Code + JetBrains)

Both plugins route `start_task` / `send_prompt` through a per-agent `AgentStrategy` interface. The pattern lives at:

- VS Code: `apps/vsc-plugin/src/services/strategies/`
  - `AgentStrategy.ts` — interface + `AgentInvocation` / `StrategyResult` types
  - `AgentStrategyRegistry.ts` — singleton dispatch (first `canHandle` wins); tracks `lastActive` for tear-down
  - `TerminalClaudeCodeStrategy.ts` — wraps `TerminalAgentService` for `__terminal__:` / `isTerminalAgent` agents
  - `CopilotLmStrategy.ts` — wraps `CopilotChatService.sendPrompt` for `__vscode_lm__:` agents (vscode.lm API)
  - `ObserverBridgeStrategy.ts` — catch-all; POSTs to the localhost observer helper at `:47832`, falls back to clipboard
- JetBrains: `apps/jetbrains-plugin/src/main/kotlin/com/windsurf/controller/services/strategies/`
  - Same shape, plus extra strategies for JCEF-rendered agents (Windsurf / Cascade, JetBrains AI Assistant, PR AI, generic JCEF fallback) — VS Code has no JCEF so those aren't ported.

The panel layer (`ControllerPanelProvider` / `ControllerToolWindowFactory`) builds an `AgentInvocation` from the incoming `RemoteCommand` and hands it to the registry. Per-agent code lives in concrete strategy files — never inline in the panel.

### "Open CLI" command (mobile → plugin → user terminal)

Mobile sends `install_cli_and_pair`. Both plugins open a local terminal and run:

```
npm install -g codeam-cli@latest && codeam pair || npx -y codeam-cli@latest pair
```

The `&&` ensures pair only runs on successful install; the `||` falls back to `npx` when `npm -g` would need sudo. Behavior is identical across VS Code (`vscode.window.createTerminal`) and JetBrains (`TerminalToolWindowManager.createLocalShellWidget`).

## Commit convention

Every commit must follow Conventional Commits:

```
<type>(<scope>): <short summary>
```

**Types:** `feat`, `fix`, `refactor`, `perf`, `docs`, `build`, `ci`, `test`, `chore`, `style`, `revert`.

**Scopes:** `cli`, `vsc-plugin`, `jetbrains-plugin`, `shared`, `workflow`, `meta`, `deps`, `release`, `changelog`.

Breaking changes: append `!` after the type/scope (`feat(cli)!: drop Node 18 support`) or add a `BREAKING CHANGE:` footer.

The release pipeline runs `git-cliff` against the commits between the previous tag and the current tag and maps types to Keep-a-Changelog sections:

| Commit type | Changelog section |
|---|---|
| `feat`     | Added |
| `fix`      | Fixed |
| `refactor` | Changed |
| `perf`     | Performance |
| `docs`     | Documentation |
| `build`    | Build |
| `ci`       | CI |
| `test`     | Tests |
| `chore`    | Chore |
| `style`    | (skipped) |
| breaking   | entry gets a `⚠️ BREAKING CHANGE` tag |

**Do not hand-edit `CHANGELOG.md`.** The release workflow generates entries, prepends them to each app's file, and commits back to `main` with `[skip ci]`. If you want a more curated note than what the commit messages produce, prefer rewording the commit before merging.

Commit messages are linted on every PR via `wagoid/commitlint-github-action` with the rules in `commitlint.config.js`.

Enable the local template once with:

```bash
npm run use-commit-template
```

That runs `git config commit.template .gitmessage` for this repo, so subsequent `git commit` invocations (without `-m`) open the template in the editor.

## Releases

Releases are **tag-triggered**. A maintainer runs:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

and `.github/workflows/release.yml` does the rest:

1. Checks out with `fetch-depth: 0` (needs full history for git-cliff).
2. Extracts the version from the tag (`vX.Y.Z` → `X.Y.Z`).
3. Patches versions in `apps/cli/package.json`, `apps/vsc-plugin/package.json`, `apps/jetbrains-plugin/build.gradle.kts`, and `apps/jetbrains-plugin/src/main/resources/META-INF/plugin.xml`.
4. `npm ci` at the workspace root → installs cli + vsc-plugin + shared together.
5. CLI typecheck + tests (must pass — release-gate).
6. Builds CLI, VS Code plugin, and the JetBrains plugin. Packages the `.vsix` and `.tgz`.
7. Publishes to npm, VS Code Marketplace, and Open VSX.
8. Runs git-cliff to generate the release's changelog section.
9. Prepends that section to each of the three `CHANGELOG.md` files and commits back to `main` with `chore(changelog): notes for vX.Y.Z [skip ci]`.
10. Creates a GitHub Release with the generated notes and all three artifacts attached.

**Required secrets** (configured in GitHub → Settings → Secrets and variables → Actions):

- `NPM_TOKEN` — an npmjs.com *Automation* access token with publish scope on `codeam-cli` **and the `@codeam` npm scope** (the tag pipeline also publishes `@codeam/shared`; the `publish-shared` job fails — without blocking client publishes — if the token lacks scope rights)
- `VSCE_PAT` — Azure DevOps personal access token for the VS Code Marketplace
- `OVSX_TOKEN` — Open VSX token for the Cursor/Windsurf store
- `JETBRAINS_MARKETPLACE_TOKEN` — JetBrains Hub permanent token (https://plugins.jetbrains.com/author/me/tokens). Auto-injected as `PUBLISH_TOKEN` env var that the Gradle plugin reads.

**JetBrains Marketplace** is fully automated alongside npm + VS Code Marketplace + Open VSX. Tagging `vX.Y.Z` publishes the plugin to the **stable** channel via `./gradlew publishPlugin` in CI. Pre-release tags (`vX.Y.Z-rc.N`) skip the marketplace push — the build still runs and the `.zip` is attached to the GitHub Release for manual upload to a non-stable channel if needed.

**Versions in git lag behind the latest tag.** The release workflow patches `apps/cli/package.json`, `apps/vsc-plugin/package.json`, `apps/jetbrains-plugin/build.gradle.kts`, and `apps/jetbrains-plugin/src/main/resources/META-INF/plugin.xml` during the build and only commits back `chore(changelog): notes for vX.Y.Z [skip ci]` — the version-bump commits are NOT pushed. So `git show HEAD:apps/cli/package.json | grep version` may show an older number than what's actually published on npm. Don't be fooled — `git describe --tags --abbrev=0` is the source of truth for what's live.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every PR:

- `commitlint` (PR only): checks every commit in the PR against `commitlint.config.js`.
- `node` job: installs workspaces, runs CLI typecheck + tests + build, then builds and packages the VS Code extension.
- `jetbrains-plugin` job: runs `./gradlew buildPlugin`.

Dependabot runs weekly for npm (per app), Gradle (jetbrains-plugin), and GitHub Actions.

## Code style

- **Prettier** — 100-char line width, 2-space indent, semicolons, single quotes, trailing commas.
- **TypeScript** — target ES2022, module ESNext, moduleResolution "bundler" for the shared package and VS Code plugin; CLI uses CommonJS for Node.
- **ESLint** — `@typescript-eslint/no-explicit-any`: error. `no-console`: only `console.warn` / `console.error` allowed. Unused variables OK if prefixed `_`. JetBrains plugin (`apps/jetbrains-plugin/`) is excluded from ESLint.
- **EditorConfig** — LF line endings; 4-space indent for Kotlin/Gradle, 2-space for everything else.
- **Node** — `.nvmrc` pins Node 20 (required by `@vscode/vsce@2.32+`). The CLI's runtime `engines.node` remains `>=18` — end users can still run Node 18; 20 is a build-time requirement only.

### Typing rules — non-negotiable

Types must be **correct and implicit**. Workarounds (`as unknown as X`, `as Record<string, unknown>`, casting through `any`) are not acceptable for hiding type errors. If TypeScript complains, fix the **source** of the error, not the symptom:

- **Third-party type is wrong/incomplete** → fix it where it crosses the boundary: define a local interface that captures the fields you actually use, or augment the third-party module via `declare module '<pkg>' { ... }`. Don't sprinkle assertions at every call site.
- **Polymorphic API response** (e.g., a chunk-protocol payload, a generic command result) → write a proper **type guard** (`function isFoo(v: unknown): v is Foo`) and use it. The guard does the runtime check; TypeScript narrows naturally with no cast at the call site. For the chunk parser, prefer Zod schemas in `packages/shared/src/protocol/`.
- **Defensive double-lookup** (`x.foo ?? (x as Cast).foo`) → if the first lookup is correctly typed, the second branch is dead code and must be removed.
- **`as` is allowed only at validated boundaries** (output of `JSON.parse` you just zod-validated, narrowing inside a type guard you just wrote, vitest mock casts for `vi.fn()`). Anywhere else, fix the type.

Do not commit code that requires `as unknown as` to compile. Do not silence TS errors with casts when the underlying type is fixable.

## Testing

The only app with an automated test suite is `apps/cli`. Framework: **Vitest** with `globals: true` and Node environment. Tests live in `apps/cli/__tests__/`.

Key conventions:

- Mock external services at the top of test files with `vi.mock()`.
- Timer-dependent logic: use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`.
- Single test file: `npm run test -- <filename pattern>`.

Adding tests for the VS Code plugin is an open invitation — it has zero coverage today, and `parseChrome` / WebSocket reconnect / selector detection are good candidates.

## Publishing gotchas

- **npm `files` allowlist** — `apps/cli/package.json` uses `"files": ["dist", "README.md", "CHANGELOG.md", "LICENSE"]`. Anything outside that list (including `src/`) does not ship in the npm tarball. Verify with `npm pack --dry-run` before tagging.
- **VS Code `.vscodeignore`** — controls the `.vsix` contents. `CHANGELOG.md` is auto-included by `vsce` unless excluded; the current ignore file correctly lets it through.
- **JetBrains `changeNotes`** — `build.gradle.kts` applies the `org.jetbrains.changelog` Gradle plugin, which reads `apps/jetbrains-plugin/CHANGELOG.md` at build time and injects the latest entry into `plugin.xml` as `<change-notes>`. The marketplace renders that on the plugin's "What's New" page.
- **Workspace resolution** — `@codeam/shared` is a workspace dep. In the CLI and VS Code plugin it is listed under `devDependencies` so tsup / esbuild bundle it inline; it must **never** be a runtime dependency. Since the package became publishable its manifest (`exports`/`main`/`types`) points at `dist/`, so each consumer pins resolution back to the workspace **source** explicitly: an esbuild `alias` in `apps/cli/tsup.config.ts` + `apps/vsc-plugin/esbuild.js`, a tsconfig `paths` entry in each app, and a vitest `resolve.alias` in each app. If you add a new build/test entry point that imports `@codeam/shared`, add the same alias — otherwise it silently bundles whatever stale `dist/` is on disk (or fails when it's absent). The `dist/` build (`npm run build` in `packages/shared`, tsup dual CJS+ESM+d.ts) exists only for the published npm artifact.

## When in doubt

- Start by reading the relevant `apps/*/src/` tree — services there are small, focused, and well named.
- For protocol / parser / pricing changes, modify `packages/shared` and read callers through `@codeam/shared`.
- For behavioral changes visible to the mobile app, also smoke-test with a real phone paired through the backend.
- If you're about to touch `apps/cli/__tests__/config.test.ts`, note that it guards session activation semantics — the `addSession` test is specifically there because the behavior has flipped between versions (now: always promote the newest paired session to active).

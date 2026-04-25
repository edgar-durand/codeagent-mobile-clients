# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working inside this repository.

## Overview

This repo holds the **client-side pieces** of [CodeAgent Mobile](https://www.codeagent-mobile.com):

- `apps/cli` — `codeam-cli`, the Node.js CLI that spawns Claude Code under a PTY and relays mobile prompts. Published to npm.
- `apps/vsc-plugin` — The VS Code / Cursor / Windsurf extension. Published to VS Code Marketplace and Open VSX.
- `apps/jetbrains-plugin` — The IntelliJ-family plugin (IntelliJ IDEA, WebStorm, PyCharm, Rider, GoLand, …). Published to JetBrains Marketplace (stable channel) by the tag-triggered release workflow.
- `packages/shared` — `@codeagent/shared`, pure-TypeScript modules (chunk-protocol parser, Anthropic pricing tables) bundled into the CLI and the VS Code extension at build time.

The backend, mobile app, and web dashboard are maintained elsewhere and are not in scope here.

## Repo layout

```
codeagent-mobile-clients/
├── apps/
│   ├── cli/                  # TypeScript · tsup · Vitest · Node ≥ 18
│   ├── vsc-plugin/           # TypeScript · esbuild · VS Code API
│   └── jetbrains-plugin/     # Kotlin · Gradle · JDK 17 · IntelliJ Platform
├── packages/
│   └── shared/               # @codeagent/shared — pure TS, bundled at build time
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

All three clients ship **under one unified version line** starting at `2.0.0`. A single `vX.Y.Z` tag releases all of them together.

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
┌─────────────────────┐   REST + WebSocket   ┌────────────────────┐
│  Mobile app / Web   │  ───────────────────▶│ CodeAgent backend  │
│  dashboard          │                       │                    │
└─────────────────────┘                       └─────────┬──────────┘
                                                        │ WS / HTTP poll
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

### Shared package (`@codeagent/shared`)

`packages/shared/src/` owns the *protocol* code — anything the CLI and the VS Code extension must agree on byte-for-byte:

- `protocol/parseChrome.ts` — detects TUI chrome lines (spinners, bullets, tree connectors, status lines) and converts them into `ChromeStep` chunks.
- `protocol/renderToLines.ts` — virtual terminal that turns raw PTY / shell-integration bytes into a clean array of screen lines. Handles CSI cursor moves, erase, alternate-screen, CR/LF quirks. Feeds every downstream parser.
- `protocol/selector.ts` — `detectSelector` (numbered `❯ 1.` style) and `detectListSelector` (`  ❯ label` list style) for Claude's interactive prompts. Both operate on the output of `renderToLines`.
- `protocol/filterChrome.ts` — strips TUI chrome (spinners, status bars, thinking frames, user-echo lines) so only Claude's conversation text reaches the mobile/web client.
- `models/pricing.ts` — Anthropic `MODEL_PRICING` and `MODEL_CONTEXT_WINDOW` tables plus `getPricing()` / `getContextWindow()` lookup helpers.

Tests live next to the modules in `packages/shared/__tests__/` and run via `(cd packages/shared && npm run test)` or are picked up by the CI job automatically.

**Critical rule:** when you touch parsing logic, pricing, or anything shared, change it *only* in `packages/shared`. Both consumers import through `@codeagent/shared`. tsup (CLI) and esbuild (VS Code) inline the imports at build time so runtime consumers don't have a separate dependency.

JetBrains plugin is Kotlin and does **not** consume the shared package — if the same logic ever needs to exist there, port it deliberately and annotate the port.

### PTY handling (CLI)

`apps/cli/src/services/claude.service.ts` spawns Claude Code inside a Python PTY helper so Claude sees `stdin.isTTY === true` even when the CLI itself was launched from a non-TTY context. On Windows or when Python is unavailable it falls back to direct spawn.

**Critical: `select_option` handling.** When navigating a React Ink selector, arrow keys MUST be sent one at a time with ≥80 ms gaps. Sending all arrows in one write collapses into a single synchronous batch — React batches the state updates and Enter always picks option 0.

### VS Code PTY

`apps/vsc-plugin/src/services/claude-pseudoterminal.ts` implements a custom `vscode.Pseudoterminal` backed by a `node-pty`-spawned `claude` process. `apps/vsc-plugin/src/services/terminal-agent.service.ts` waits for the `? for shortcuts` readiness marker before submitting the first prompt — a fixed-delay idle check drops the first prompt during Ink's initial render pause.

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

- `NPM_TOKEN` — an npmjs.com *Automation* access token with publish scope on `codeam-cli`
- `VSCE_PAT` — Azure DevOps personal access token for the VS Code Marketplace
- `OVSX_TOKEN` — Open VSX token for the Cursor/Windsurf store
- `JETBRAINS_MARKETPLACE_TOKEN` — JetBrains Hub permanent token (https://plugins.jetbrains.com/author/me/tokens). Auto-injected as `PUBLISH_TOKEN` env var that the Gradle plugin reads.

**JetBrains Marketplace** is fully automated alongside npm + VS Code Marketplace + Open VSX. Tagging `vX.Y.Z` publishes the plugin to the **stable** channel via `./gradlew publishPlugin` in CI. Pre-release tags (`vX.Y.Z-rc.N`) skip the marketplace push — the build still runs and the `.zip` is attached to the GitHub Release for manual upload to a non-stable channel if needed.

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
- **Workspace resolution** — `@codeagent/shared` is a workspace dep. In the CLI and VS Code plugin it is listed under `devDependencies` so tsup / esbuild bundle it inline; it must **never** be a runtime dependency.

## When in doubt

- Start by reading the relevant `apps/*/src/` tree — services there are small, focused, and well named.
- For protocol / parser / pricing changes, modify `packages/shared` and read callers through `@codeagent/shared`.
- For behavioral changes visible to the mobile app, also smoke-test with a real phone paired through the backend.
- If you're about to touch `apps/cli/__tests__/config.test.ts`, note that it guards session activation semantics — the `addSession` test is specifically there because the behavior has flipped between versions (now: always promote the newest paired session to active).

# CodeAgent Mobile — Clients

Public source for the **client-side bridges** of [CodeAgent Mobile](https://www.codeagent-mobile.com) — the workflow-continuity layer for AI coding agents.

- [`apps/cli`](apps/cli) — `codeam-cli`, the terminal bridge that wraps Claude Code in a PTY and streams it to any device
- [`apps/vsc-plugin`](apps/vsc-plugin) — extension for **VS Code**, **Cursor**, and **Windsurf**
- [`apps/jetbrains-plugin`](apps/jetbrains-plugin) — plugin for the **IntelliJ** family (IntelliJ IDEA, WebStorm, PyCharm, Rider, GoLand, …)

> **What is CodeAgent Mobile?**
> The supervision layer for agents already running in your IDE. Now that AI agents run for hours, not seconds, you no longer need to stare at a terminal — CodeAgent streams the session to your phone or web dashboard so you can approve diffs, redirect prompts, and stay in the loop async. Works with Claude Code, Copilot, Cursor, Windsurf, JetBrains AI, OpenAI Codex, Vertex AI, and any agent in your editor.
>
> Install once in your IDE, pair with a QR, your workflow follows you across devices. See [codeagent-mobile.com](https://www.codeagent-mobile.com).

---

## Install (users)

### CLI — `codeam-cli`

```bash
npm install -g codeam-cli
codeam pair   # generates a 6-character code
codeam        # starts Claude Code with mobile control
```

[![npm](https://img.shields.io/npm/v/codeam-cli.svg?color=34d399&style=flat-square)](https://www.npmjs.com/package/codeam-cli)

### VS Code / Cursor / Windsurf

- **VS Code Marketplace** → search for *CodeAgent Mobile*  ·  [listing](https://marketplace.visualstudio.com/items?itemName=CodeAgentMobile.codeagent-mobile)
- **Cursor / Open VSX** → [CodeAgentMobile/codeagent-mobile](https://open-vsx.org/extension/CodeAgentMobile/codeagent-mobile)

### JetBrains

- **JetBrains Marketplace** → [CodeAgent-Mobile](https://plugins.jetbrains.com/plugin/30697-codeagent-mobile)

---

## Environment variables

Every client (CLI + both plugins) reads the same two env vars to pick which API host it talks to. Priority order — first match wins:

| Variable | Effect |
|---|---|
| `CODEAM_API_URL` | Full URL override. Use when pointing at a custom staging endpoint or a self-hosted instance. Example: `CODEAM_API_URL=https://staging-api.example.com codeam pair`. |
| `CODEAM_TEST_MODE=1` | Shortcut that routes every request at the **dev preview** (`https://dev-api.codeagent-mobile.com`) without you having to know the URL. Use this when pairing from `dev.codeagent-mobile.com`. |
| _(none)_ | Defaults to production (`https://api.codeagent-mobile.com`). |

The shortcut exists because prod + dev share Redis: a code generated against prod-api is also valid against dev-api, so a pair started in the dev webapp completes silently against prod (heartbeats keep going to the wrong host). `CODEAM_TEST_MODE=1` flips every endpoint — pairing, command relay, SSE, chunk uploads, file watcher, history — in lockstep.

```bash
# Quick check it's active:
CODEAM_TEST_MODE=1 codeam doctor
# api      https://dev-api.codeagent-mobile.com
# mode     TEST_MODE — using dev preview
```

VS Code / JetBrains plugins read the same env vars from the host process — set them in your shell before launching the IDE. The `apiBaseUrl` setting in each plugin still works as a manual override (highest priority of all in the plugin context).

---

## Repository layout

```
codeagent-mobile-clients/
├── apps/
│   ├── cli/                 # codeam-cli (TypeScript · tsup · Node ≥ 18)
│   ├── vsc-plugin/          # VS Code extension (TypeScript · esbuild)
│   └── jetbrains-plugin/    # IntelliJ plugin (Kotlin · Gradle · JDK 17)
├── packages/
│   └── shared/              # @codeam/shared — chrome parser +
│                            # model pricing tables, bundled into CLI
│                            # and the VS Code extension at build time
├── package.json             # npm workspaces + root scripts
├── .github/workflows/       # CI (PRs) + Release (tag-triggered publish)
├── .eslintrc.json           # shared lint config (CLI + VS Code plugin)
├── .prettierrc              # shared formatter config
├── .editorconfig            # editor defaults
└── .nvmrc                   # Node version pin
```

The CLI and VS Code extension share a small TypeScript package (`packages/shared`) that holds the chunk-protocol parser and the model-pricing tables. At build time `tsup` (CLI) and `esbuild` (VS Code) inline it into each consumer's bundle, so neither published artifact depends on a separate package at runtime. The JetBrains plugin is Kotlin and does not consume the shared package.

---

## Build from source

Clone, then install per-app dependencies:

```bash
git clone https://github.com/edgar-durand/codeagent-mobile-clients.git
cd codeagent-mobile-clients
(cd apps/cli && npm install)
(cd apps/vsc-plugin && npm install)
```

Root convenience scripts:

| Script | What it does |
|---|---|
| `npm run build:cli` | Build `codeam-cli` → `apps/cli/dist/` |
| `npm run dev:cli` | `tsup --watch` for the CLI |
| `npm run test:cli` | Vitest for the CLI |
| `npm run publish:cli` | `npm publish` (from `apps/cli`) |
| `npm run build:vsc-plugin` | Build + `vsce package` → `apps/vsc-plugin/*.vsix` |
| `npm run publish:vsc-plugin` | Publish to VS Code Marketplace (needs `.env` with `PAT`) |
| `npm run publish:vsc-plugin:cursor` | Publish to Open VSX (needs `.env` with `OVSX_TOKEN`) |
| `npm run build:jetbrains-plugin` | `gradlew clean buildPlugin` → `apps/jetbrains-plugin/build/distributions/*.zip` |
| `npm run reinstall:jetbrains-plugin` | Rebuild + reinstall into local WebStorm (dev helper) |

### Prerequisites

- **Node.js ≥ 18** (CLI + VSC plugin)
- **Python 3** (CLI — required at runtime for the PTY helper on macOS / Linux; Windows falls back to direct spawn)
- **JDK 17** (JetBrains plugin — the root scripts pin `JAVA_HOME` to Homebrew's `openjdk@17`; adjust if yours lives elsewhere)
- **Gradle** — the wrapper (`gradlew`) is committed, no global install needed

### Build everything at once

```bash
npm run build:cli
npm run build:vsc-plugin
npm run build:jetbrains-plugin
```

---

## Releases & changelogs

Each app ships independently and keeps its own version number and changelog:

| App | Current | Changelog | Registry |
|---|---|---|---|
| `codeam-cli` | **2.0.0** | [apps/cli/CHANGELOG.md](apps/cli/CHANGELOG.md) | [npm](https://www.npmjs.com/package/codeam-cli) |
| VS Code plugin | **2.0.0** | [apps/vsc-plugin/CHANGELOG.md](apps/vsc-plugin/CHANGELOG.md) | [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=CodeAgentMobile.codeagent-mobile) · [Open VSX](https://open-vsx.org/extension/CodeAgentMobile/codeagent-mobile) |
| JetBrains plugin | **2.0.0** | [apps/jetbrains-plugin/CHANGELOG.md](apps/jetbrains-plugin/CHANGELOG.md) | [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/30697-codeagent-mobile) |

From **2.0.0 onwards all three clients ship under the same version line.** Pushing a single tag `vX.Y.Z` releases `codeam-cli@X.Y.Z` to npm, the VS Code extension `X.Y.Z` to both the VS Code Marketplace and Open VSX, and the JetBrains plugin `X.Y.Z` to the JetBrains Marketplace stable channel via the automated [release workflow](.github/workflows/release.yml). Pre-release tags (`vX.Y.Z-rc.N`) skip the JetBrains marketplace push — the `.zip` is still attached to the GitHub Release for manual upload to a non-stable channel.

Publishing secrets (`PAT`, `OVSX_TOKEN`, `CERTIFICATE_CHAIN`, `PRIVATE_KEY`, `PRIVATE_KEY_PASSWORD`, `PUBLISH_TOKEN`) live in local `.env` files and are gitignored — they never land in this repo.

---

## Architecture (where this fits in)

```
┌─────────────────────┐   REST + WebSocket   ┌────────────────────┐
│  Mobile app / Web   │  ───────────────────▶│ CodeAgent backend  │
│  dashboard          │                       │                    │
└─────────────────────┘                       └─────────┬──────────┘
                                                        │ WebSocket / HTTP poll
                                                        ▼
                                              ┌────────────────────┐
                                              │   THIS REPO        │
                                              │ ──────────────     │
                                              │ • codeam-cli       │
                                              │ • VS Code plugin   │
                                              │ • JetBrains plugin │
                                              └──────────┬─────────┘
                                                         │ PTY / IDE APIs
                                                         ▼
                                              ┌────────────────────┐
                                              │  Claude Code /     │
                                              │  OpenAI Codex /    │
                                              │  Copilot / Cursor  │
                                              │  / JetBrains AI…   │
                                              └────────────────────┘
```

The clients never talk to each other. Each one connects to the backend relay and relays commands to whichever local agent (Claude Code via PTY, Copilot Chat via the VS Code API, IntelliJ terminal, etc.) the user has selected.

---

## Contributing

Issues and pull requests are welcome. Please:

1. Open an issue first for non-trivial changes so we can align on scope.
2. Keep changes scoped to one app when possible.
3. Run `npm run test:cli` (CLI) and make sure `npm run build:*` succeeds before opening a PR.

For backend / mobile app / web dashboard issues, use the in-app *Help & FAQ* — those sources aren't in this repo.

---

## License

[MIT](LICENSE) © Edgar Durand

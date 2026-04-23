# CodeAgent Mobile — Clients

Public source for the **client-side pieces** of [CodeAgent Mobile](https://www.codeagent-mobile.com):

- [`apps/cli`](apps/cli) — `codeam-cli`, the terminal companion that spawns Claude Code under a PTY and relays your mobile prompts
- [`apps/vsc-plugin`](apps/vsc-plugin) — extension for **VS Code**, **Cursor**, and **Windsurf**
- [`apps/jetbrains-plugin`](apps/jetbrains-plugin) — plugin for the **IntelliJ** family (IntelliJ IDEA, WebStorm, PyCharm, Rider, GoLand, etc.)

The backend, mobile app (iOS/Android), and web dashboard are maintained in a private repository. Only the clients live here.

> **What is CodeAgent Mobile?**
> It lets you drive AI coding agents (Claude Code, Copilot, Cursor, JetBrains AI, etc.) from your phone. Pair your device once, then send prompts, stream responses, and approve interactive commands — from anywhere. See [codeagent-mobile.com](https://www.codeagent-mobile.com).

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
- **Cursor / Open VSX** → available via [Open VSX](https://open-vsx.org/)
- **Manual**: download the `.vsix` and `Install from VSIX…`

### JetBrains

- **JetBrains Marketplace** → [CodeAgent-Mobile](https://plugins.jetbrains.com/plugin/30697-codeagent-mobile)
- **Manual**: install the `.zip` via *Settings → Plugins → ⚙ → Install Plugin from Disk…*

---

## Repository layout

```
codeagent-mobile-clients/
├── apps/
│   ├── cli/                 # codeam-cli (TypeScript · tsup · Node ≥ 18)
│   ├── vsc-plugin/          # VS Code extension (TypeScript · esbuild)
│   └── jetbrains-plugin/    # IntelliJ plugin (Kotlin · Gradle · JDK 17)
├── package.json             # root scripts (wrappers for each app)
├── .eslintrc.json           # shared lint config (CLI + VSC plugin)
├── .prettierrc              # shared formatter config
└── .gitignore
```

Each app is self-contained — they don't depend on each other, and none of them pulls from a shared workspace package.

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

## Releasing

Each app ships independently and keeps its own version number:

| App | Version file | Registry |
|---|---|---|
| CLI | `apps/cli/package.json` | [npm](https://www.npmjs.com/package/codeam-cli) |
| VS Code plugin | `apps/vsc-plugin/package.json` | [VS Code Marketplace](https://marketplace.visualstudio.com/) + [Open VSX](https://open-vsx.org/) |
| JetBrains plugin | `apps/jetbrains-plugin/build.gradle.kts` (`version = …`) + `plugin.xml` (`<version>`) | [JetBrains Marketplace](https://plugins.jetbrains.com/) |

Publishing secrets (`PAT`, `OVSX_TOKEN`, `CERTIFICATE_CHAIN`, `PRIVATE_KEY`, `PRIVATE_KEY_PASSWORD`, `PUBLISH_TOKEN`) live in local `.env` files and are gitignored — they never land in this repo.

---

## Architecture (where this fits in)

```
┌─────────────────────┐   REST + WebSocket   ┌────────────────────┐
│  Mobile app / Web   │  ───────────────────▶│ CodeAgent backend  │
│  dashboard          │                       │  (private repo)    │
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

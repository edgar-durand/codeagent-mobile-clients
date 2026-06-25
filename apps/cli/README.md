# codeam-cli

[![npm version](https://img.shields.io/npm/v/codeam-cli.svg?color=34d399&style=flat-square)](https://www.npmjs.com/package/codeam-cli)
[![npm downloads](https://img.shields.io/npm/dm/codeam-cli.svg?color=34d399&style=flat-square)](https://www.npmjs.com/package/codeam-cli)
[![license](https://img.shields.io/npm/l/codeam-cli.svg?color=34d399&style=flat-square)](https://github.com/edgar-durand/codeagent-mobile-clients/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/codeam-cli.svg?color=34d399&style=flat-square)](https://nodejs.org/)

> **The workflow-continuity bridge for AI coding agents.**
> Wrap Claude Code or Codex once, then supervise, approve, and redirect from any device — async.

`codeam-cli` is the terminal bridge for [**CodeAgent Mobile**](https://codeagent-mobile.com). It wraps AI coding agents inside a pseudo-terminal and streams the entire session — output, diffs, interactive selectors — to your phone or web dashboard so you can stay in the loop while the agent runs for hours instead of seconds.

Currently supports **[Claude Code](https://claude.ai/code)** (Anthropic) and **[OpenAI Codex](https://github.com/openai/codex)** — start either via `codeam` (Claude Code) or `codeam codex` (OpenAI Codex).

---

## Why does this exist?

AI agents went async. They write, refactor, test, and ship code on their own — for hours, not seconds. Most CLI workflows still pin you to one screen while that happens.

`codeam-cli` is the supervision layer on top: run the agent locally exactly like you would today, and a paired phone / browser becomes a remote checkpoint. Approve diffs while you're away from the desk. Redirect a long-running refactor over coffee. Step into a meeting without losing the session.

Same terminal, same project, same files — just no longer chained to the desk.

---

## Quick Start

```bash
# 1. Install once
npm install -g codeam-cli

# 2. Pair your phone (generates a 6-character code)
codeam pair

# 3. Run Claude Code with mobile control (every time after that)
codeam
```

That's it. Open the [CodeAgent Mobile app](https://codeagent-mobile.com), enter the code, and you're controlling Claude Code from your phone.

---

## Commands

| Command | What it does |
|---|---|
| `codeam` | Start the active agent in the current directory, with mobile control |
| `codeam <agent>` | Start a specific agent — `codeam claude`, `codeam codex`, … |
| `codeam pair` | Pair a new mobile device (6-character code or QR, interactive agent picker) |
| `codeam pair --agent <id>` | Pair non-interactively for a specific agent (`claude`, `codex`, …) — useful in scripts |
| `codeam pair-auto` | redeem a one-shot auto-pair token from `--token`, `--token-file`, or `CODEAM_AUTO_TOKEN` |
| `codeam link <agent>` | capture local credentials for `<agent>` and store them for cloud workspace reuse |
| `codeam sessions` | List all paired devices |
| `codeam sessions switch` | Choose which paired session the next `codeam` invocation will use |
| `codeam sessions delete <session-id>` | Forget a specific paired session (leaves the others intact) |
| `codeam status` | Show connection status |
| `codeam invite` | Print your referral link — share it to earn PRO for you and the devs you bring |
| `codeam doctor` | run environment, install, and pairing diagnostics (`--json` for machine-readable output) |
| `codeam logout` | Remove all paired sessions |
| `codeam deploy` | Provision a cloud workspace (GitHub Codespaces) and pair it to your phone |
| `codeam deploy ls` (alias `list`) | List the cloud workspaces you've deployed (and which still have a session running) |
| `codeam deploy stop` (alias `remove`) | Pick a deployed workspace and stop its codeam session (and optionally the workspace itself) |
| `codeam host enroll --token <token>` | Enroll **this machine** as a self-hosted execution target (the token is minted by the mobile/web app) |
| `codeam host-agent` | Run the self-hosted supervisor (the enroll step installs this as a systemd service — you rarely call it by hand) |
| `codeam completion <shell>` | print shell completions for `<shell>` (`bash`, `zsh`, or `fish`) |
| `codeam --version`, `-v` | Print the installed CLI version |
| `codeam --help`, `-h` | Show usage and the full command list |

---

## `codeam invite` — share your referral link

Once you're paired, run:

```bash
codeam invite
```

The CLI fetches your personal referral link from the backend and prints it. Share it with teammates: every developer who signs up through your link and pairs their first session earns **both of you 14 days of PRO** — at no extra cost.

> Requires an active paired session (`codeam pair` first).

---

## `codeam deploy` — drive a cloud workspace from your phone

Don't want to keep your laptop running while you control Claude from the train? `codeam deploy` spins up a fresh **GitHub Codespace** for any of your repos, installs Claude Code + `codeam-cli` inside it, copies your local Claude credentials so you skip the re-auth (or runs `claude login` interactively if you don't have a local config yet), supervises the agent with **PM2** so the session survives even after you close your laptop, and gives you a QR/code to pair your phone — straight from your local terminal.

```bash
codeam deploy
```

That's it. You'll be guided through:

1. **Pick a provider** (GitHub Codespaces today; more coming).
2. **Pick a repo** from your account.
3. **Reuse an existing codespace or create a new one** — re-runs of `codeam deploy` against the same project don't pile up codespaces.
4. **Wait ~1 minute** while the codespace boots and tools install.
5. **Scan the QR / enter the code** on the CodeAgent Mobile app.
6. Your local terminal **automatically disconnects** once Claude is ready — close the laptop, the agent keeps running on the codespace, and your phone stays connected.

Requirements: the [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated (`gh auth login`). The deploy flow re-uses `gh`'s OAuth — we don't ask for a separate token.

### Managing your deployed workspaces

```bash
# Show every workspace you've deployed and whether codeam is still running on it.
codeam deploy ls

# Pick one and stop the codeam session — also offers to stop the workspace
# itself so you don't burn compute hours.
codeam deploy stop
```

Stopping a workspace via `codeam deploy stop` is non-destructive: the GitHub Codespace stays around (preserving your branch, files, and dotfiles); only the running compute is paused. Re-running `codeam deploy` will offer to resume that same codespace.

Adding more managed cloud backends (Gitpod, Coder, …) is a single new file in `apps/cli/src/services/providers/` — the `CloudProvider` interface keeps it pluggable. To run on **your own server** instead, see the next section.

---

## Self-hosted execution plane — run agents on your own server

Prefer to run the execution plane on **your own hardware** (a VPS, homelab, or GPU box) instead of a managed Codespace? CodeAgent can provision the same agent runtime on any Linux server you own — with **zero inbound ports, no tunnel, and without ever handing us your SSH keys**. The box only needs outbound internet.

**Setup is a one-time paste, driven from the app:**

1. In the CodeAgent Mobile app (or web dashboard), open the deploy flow and pick **Self-hosted → Add server**. It shows a one-line install command carrying a short-lived enroll token.
2. Paste it into an SSH session on your box:
   ```bash
   curl -fsSL https://api.codeagent-mobile.com/api/self-hosted/enroll.sh | sh -s -- --token=<enroll-token>
   ```
   That installs `codeam-cli`, registers a **systemd** service (`codeam-host-agent`), and connects it back over the same **outbound** relay everything else uses. It survives reboots.
3. From then on it's **100% phone/web-driven**: pick the host + a repo (or an absolute path on the box) + an agent, and a session spins up on your server — supervised from your phone like any other. Stop sessions or remove the host from the app.

Under the hood the installer runs `codeam host enroll` (redeems the token, seals a long-lived host-token to `~/.codeam/host-agent.json`) and starts `codeam host-agent` (the supervisor that spawns a `codeam pair-auto` child per deploy, injecting your linked agent's credentials). You normally never invoke these by hand.

> **Deploying to and managing self-hosted servers happens in the mobile/web app, not the CLI.** The CLI's role here is the one-time enrollment plus the long-running host-agent. Requires Linux + systemd.

---

## Requirements

- **Node.js 20+**
- **Claude Code** — see the [official quickstart](https://code.claude.com/docs/en/quickstart)
- **OpenAI Codex** (optional) — see the [official quickstart](https://github.com/openai/codex)
- **[CodeAgent Mobile](https://codeagent-mobile.com)** app on your phone ([iOS](https://apps.apple.com/) / [Android](https://play.google.com/store/apps/details?id=com.codeagent.mobile))

---

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `CODEAM_API_URL` | `https://api.codeagent-mobile.com` | Override the backend relay URL. Useful for hitting a staging environment or self-hosted backend. |
| `CODEAM_DISABLE_UPDATE_CHECK` | unset | Set to `1` to suppress the "update available" banner. The check also auto-skips on non-TTY stdout, when `CI=true`, and during tests. |
| `CODEAM_AUTO_TOKEN` | unset | One-shot pairing token consumed by `codeam pair-auto`. Used by the `codeam deploy` bootstrap; see *Advanced / scripted pairing* below. |

---

## Advanced / scripted pairing

For automation (CI, Codespaces bootstraps, container entry-points) `codeam` ships a non-interactive pairing command:

```bash
codeam pair-auto --token=<one-shot-pairing-token>
# or
codeam pair-auto --token-file=/path/to/token
# or pass the token via env:
CODEAM_AUTO_TOKEN=<token> codeam pair-auto
```

This is the same path `codeam deploy` uses inside a freshly-provisioned Codespace to pair the cloud session to your phone with zero interactive prompts. End users on a laptop should keep using the interactive `codeam pair`.

---

## How it works

1. `codeam-cli` spawns Claude Code inside a Python PTY helper so Claude sees a real TTY.
2. Raw PTY output runs through a virtual terminal renderer, interactive selectors are detected, and TUI chrome is filtered out.
3. Clean output chunks are pushed to CodeAgent's backend relay.
4. Your phone connects to the same relay via WebSocket. Every prompt you type on mobile is sent back to the PTY as if typed on your keyboard.
5. Everything happens on **your machine** — your code never leaves it. The relay only forwards prompts and sanitized output.

---

## Related

- **[CodeAgent Mobile app](https://codeagent-mobile.com)** — the phone app this CLI talks to
- **[VS Code / Cursor / Windsurf extension](https://marketplace.visualstudio.com/items?itemName=CodeAgentMobile.codeagent-mobile)** — use inside your editor instead of the terminal
- **[JetBrains plugin](https://plugins.jetbrains.com/plugin/30697-codeagent-mobile)** — IntelliJ, WebStorm, PyCharm, Rider, etc.
- **[FAQ & Docs](https://codeagent-mobile.com/faq)**

---

## License

MIT © [Edgar Durand](https://github.com/edgar-durand)

Source: [github.com/edgar-durand/codeagent-mobile-clients](https://github.com/edgar-durand/codeagent-mobile-clients)

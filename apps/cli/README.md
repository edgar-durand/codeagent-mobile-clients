# codeam-cli

[![npm version](https://img.shields.io/npm/v/codeam-cli.svg?color=34d399&style=flat-square)](https://www.npmjs.com/package/codeam-cli)
[![npm downloads](https://img.shields.io/npm/dm/codeam-cli.svg?color=34d399&style=flat-square)](https://www.npmjs.com/package/codeam-cli)
[![license](https://img.shields.io/npm/l/codeam-cli.svg?color=34d399&style=flat-square)](https://github.com/edgar-durand/codeagent-mobile-clients/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/codeam-cli.svg?color=34d399&style=flat-square)](https://nodejs.org/)

> **Remote control [Claude Code](https://claude.ai/code) from your phone.**
> Send prompts, stream responses, and approve commands in real-time — from the subway, the couch, or anywhere away from your desk.

`codeam-cli` is the companion CLI for [**CodeAgent Mobile**](https://codeagent-mobile.com). It wraps Claude Code inside a pseudo-terminal, relays your mobile prompts to the agent, and streams the output back to your phone in real-time.

---

## Why does this exist?

Because sometimes your best ideas happen away from the keyboard. Maybe you're on a walk, on the train, in a meeting, or just want to keep a long-running task going while you step away. `codeam-cli` lets your AI agent keep working — and lets **you** keep shipping — without needing to be at your machine.

It works exactly like Claude Code (same terminal, same project, same files), but every prompt and every response is mirrored on your phone. You can even approve interactive selectors and confirmations from mobile.

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
| `codeam` | Start Claude Code in the current directory, with mobile control |
| `codeam pair` | Pair a new mobile device (6-digit code or QR) |
| `codeam sessions` | List all paired devices |
| `codeam status` | Show connection status |
| `codeam logout` | Remove all paired sessions |

---

## Requirements

- **Node.js 18+**
- **Claude Code** — see the [official quickstart](https://code.claude.com/docs/en/quickstart)
- **[CodeAgent Mobile](https://codeagent-mobile.com)** app on your phone ([iOS](https://apps.apple.com/) / [Android](https://play.google.com/store/apps/details?id=com.codeagent.mobile))

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

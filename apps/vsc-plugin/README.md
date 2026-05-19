# CodeAgent — Remote AI Supervision

The workflow-continuity bridge for AI coding agents. Supervise, approve, and redirect the agents running in VS Code, Cursor, or Windsurf from any device — async.

🌐 **Homepage**: [https://www.codeagent-mobile.com](https://www.codeagent-mobile.com)

## Why this extension

AI agents now run for hours, not seconds. Most developer workflows still pin you to a single screen while that happens. This extension turns your editor into the agent's home base — the agent keeps writing, refactoring, and shipping while a paired phone / browser becomes your remote checkpoint.

- **Stay in the loop while a long refactor builds**
- **Approve diffs, redirect prompts, or course-correct from anywhere**
- **Hand off work between devices without breaking the session**
- **Share live agent sessions with teammates in Team Spaces**

## Features

- **One-tap pairing**: pair your phone with VS Code via QR or 6-digit code
- **Auto-detect agents**: works with whatever AI extension is already installed (Copilot, Claude, Codeium, etc.)
- **Async prompt relay**: send prompts from anywhere; agent runs locally in your IDE
- **MCP server config**: configure Model Context Protocol servers from your phone
- **Live status**: monitor the paired session + agent state from the sidebar

## Supported AI Agents

- GitHub Copilot Chat
- Claude Code / Claude Dev (Cline)
- OpenAI Codex
- Codeium / Windsurf / Cascade
- Tabnine
- Amazon Q
- Sourcegraph Cody
- Continue
- Supermaven
- Gemini Code Assist
- Any other AI extension with a chat panel

## Getting Started

### 1. Install the Plugin

#### From VS Code Marketplace

1. Open the Extensions view (`Ctrl+Shift+X`)
2. Search for **"CodeAgent Mobile"**
3. Click **Install**

#### From Open VSX (Cursor / Windsurf)

The extension is also published to [Open VSX](https://open-vsx.org/extension/CodeAgentMobile/codeagent-mobile) so Cursor and Windsurf can install it directly from their Extensions view.

### 2. Get the Mobile App or Use the Web Dashboard

You need the **CodeAgent Mobile** companion app to send prompts to your IDE:

- **📱 Mobile App** (recommended): Download from the [App Store](#) or [Play Store](#)
- **🌐 Web Dashboard**: Use the browser-based dashboard at [codeagent-mobile.com/dashboard](https://www.codeagent-mobile.com/dashboard) — no install required

### 3. Pair Your Device

1. Click the **CodeAgent Mobile** icon in the activity bar (sidebar)
2. Click **Generate Pairing Code**
3. Open the mobile app or web dashboard and enter the 6-digit code
4. Start sending prompts from your phone or browser!

## Build from Source

The source lives at [github.com/edgar-durand/codeagent-mobile-clients](https://github.com/edgar-durand/codeagent-mobile-clients).

```bash
git clone https://github.com/edgar-durand/codeagent-mobile-clients.git
cd codeagent-mobile-clients/apps/vsc-plugin
npm install
npm run build
npx @vscode/vsce package --no-dependencies
```

## Commands

- `CodeAgent Mobile: Show Pairing Code` - Open panel and show pairing code
- `CodeAgent Mobile: Disconnect` - Disconnect current session
- `CodeAgent Mobile: Open Panel` - Open the sidebar panel

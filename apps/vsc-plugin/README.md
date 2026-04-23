# CodeAgent Mobile - VS Code Extension

Control your AI coding agents remotely from your mobile device.

🌐 **Homepage**: [https://www.codeagent-mobile.com](https://www.codeagent-mobile.com)

## Features

- **Remote Pairing**: Pair your mobile device with VS Code using a 6-digit code
- **AI Agent Detection**: Automatically detects installed AI extensions (Copilot, Claude, Codeium, etc.)
- **Prompt Relay**: Send prompts from your phone directly to your IDE's AI assistant
- **MCP Configuration**: Configure Model Context Protocol servers remotely
- **Real-time Status**: Monitor connection and agent status from the sidebar

## Supported AI Agents

- GitHub Copilot Chat
- Claude Code / Claude Dev (Cline)
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

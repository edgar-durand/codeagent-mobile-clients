import * as vscode from 'vscode';
import { SettingsService } from './services/settings.service';
import { WebSocketService } from './services/websocket.service';
import { CommandRelayService } from './services/command-relay.service';
import { PairingService } from './services/pairing.service';
import { IdeIntegrationService } from './services/ide-integration.service';
import { TerminalAgentService } from './services/terminal-agent.service';
import { AgentBridgeService } from './services/agent-bridge.service';
import { AgentOutputMonitor } from './services/agent-output-monitor';
import { McpConfigWriterService } from './services/mcp-config-writer.service';
import { CopilotChatService } from './services/copilot-chat.service';
import { ChatHistoryService } from './services/chat-history.service';
import { ClaudeContextService } from './services/claude-context.service';
import { ControllerPanelProvider } from './panels/controller-panel';

let log: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('CodeAgent Mobile');
  log.appendLine('CodeAgent Mobile extension activating...');

  // Initialize all services
  SettingsService.initialize(context);
  WebSocketService.initialize(log);
  CommandRelayService.initialize(log);
  PairingService.initialize(log);
  IdeIntegrationService.initialize(log);
  TerminalAgentService.initialize(log);
  AgentOutputMonitor.initialize(log);
  McpConfigWriterService.initialize(log);
  CopilotChatService.initialize(log);
  ChatHistoryService.initialize(context, log);
  ClaudeContextService.initialize(log);
  AgentBridgeService.initialize(log);

  // Register webview panel provider
  const panelProvider = new ControllerPanelProvider(context.extensionUri, log);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ControllerPanelProvider.viewType, panelProvider),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codeagent-mobile.showPairingCode', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.codeagent-mobile');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeagent-mobile.disconnect', () => {
      const relay = CommandRelayService.getInstance();
      relay.reportOffline();
      relay.stopPolling();
      WebSocketService.getInstance().disconnect();
      PairingService.getInstance().clearCurrentSession();
      vscode.window.showInformationMessage('CodeAgent Mobile: Disconnected');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeagent-mobile.openPanel', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.codeagent-mobile');
    }),
  );

  // Detect and report installed agents on startup
  const ide = IdeIntegrationService.getInstance();
  ide.detectInstalledAgents().then((agents) => {
    log.appendLine(`Detected ${agents.length} AI agents on activation`);
  });

  // Status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(broadcast) CodeAgent';
  statusBarItem.tooltip = 'CodeAgent Mobile - Click to open';
  statusBarItem.command = 'codeagent-mobile.openPanel';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Start capture server (no workbench.html modification — that causes "corrupt" warnings)
  AgentOutputMonitor.getInstance().safeStartup();

  log.appendLine('CodeAgent Mobile extension activated');
}

export function deactivate(): void {
  log?.appendLine('CodeAgent Mobile extension deactivating...');

  try {
    CommandRelayService.getInstance().reportOffline();
    CommandRelayService.getInstance().stopPolling();
  } catch { /* not initialized */ }

  try {
    WebSocketService.getInstance().disconnect();
  } catch { /* not initialized */ }

  try {
    AgentOutputMonitor.getInstance().dispose();
  } catch { /* not initialized */ }

  try {
    TerminalAgentService.getInstance().stopMonitoring();
  } catch { /* not initialized */ }

  log?.appendLine('CodeAgent Mobile extension deactivated');
}

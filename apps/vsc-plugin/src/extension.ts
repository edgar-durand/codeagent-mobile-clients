import * as vscode from 'vscode';
import { SettingsService } from './services/settings.service';
import { CommandRelayService } from './services/command-relay.service';
import { PairingService } from './services/pairing.service';
import { IdeIntegrationService } from './services/ide-integration.service';
import { AgentOutputMonitor } from './services/agent-output-monitor';
import { McpConfigWriterService } from './services/mcp-config-writer.service';
import { CopilotChatService } from './services/copilot-chat.service';
import { ChatHistoryService } from './services/chat-history.service';
import { ControllerPanelProvider } from './panels/controller-panel';
import { initTelemetry, capture, identifyUser, shutdownTelemetry } from './services/telemetry.service';
import { Messages } from './ui/messages';
import { StatusBar } from './ui/status-bar';

let log: vscode.OutputChannel;
let panelProvider: ControllerPanelProvider | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log = vscode.window.createOutputChannel('CodeAgent Mobile');
  log.appendLine('CodeAgent Mobile extension activating...');

  // Initialize all services. SettingsService is awaited so the
  // SecretStorage-backed pluginAuthToken is in the in-memory cache
  // before any HTTP service tries to read it.
  await SettingsService.initialize(context);
  CommandRelayService.initialize(log);
  PairingService.initialize(log);
  IdeIntegrationService.initialize(log);
  AgentOutputMonitor.initialize(log);
  McpConfigWriterService.initialize(log);
  CopilotChatService.initialize(log);
  ChatHistoryService.initialize(context, log);

  // Register webview panel provider
  panelProvider = new ControllerPanelProvider(context.extensionUri, log);
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
      panelProvider?.stopFileWatcher();
      PairingService.getInstance().clearCurrentSession();
      vscode.window.showInformationMessage(Messages.Disconnected);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeagent-mobile.openPanel', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.codeagent-mobile');
    }),
  );

  // Agent detection used to fire at activation, which pays the 2s
  // vscode.lm consent timeout on every cold start whether the user
  // ever pairs or not. Defer to the first pairing — the panel itself
  // re-runs detection in its onPaired listener, so dropping this
  // line just removes the eager work.
  // (Was: `ide.detectInstalledAgents().then(...)`.)

  // Test-only command — registered ONLY when the extension is hosted
  // by @vscode/test-electron (CODEAM_VSC_TEST=1 in the env). Lets the
  // E2E suite probe the pair-backend endpoint against the same code
  // path the panel's QR button takes, without needing to inject a
  // postMessage into the sandboxed webview. Returns the raw result of
  // PairingService.requestPairingCode() so the test can assert on
  // shape (code / expiresAt).
  if (process.env.CODEAM_VSC_TEST === '1') {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'codeagent-mobile.test.probePairBackend',
        async () => {
          return PairingService.getInstance().requestPairingCode();
        },
      ),
    );
    log.appendLine('Test-only command registered: codeagent-mobile.test.probePairBackend');
  }

  // Status bar item — owned by the StatusBar helper which mirrors
  // the side-panel's 3-state surface (online / reconnecting /
  // offline) and surfaces agent count + last-sync age + protocol
  // version in the MarkdownString tooltip.
  const statusBar = StatusBar.initialize();
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  // The capture server + legacy workbench cleanup only matter once
  // the user pairs (the observer script in the IDE renderer is what
  // talks to that server). Defer to the first pair so cold-start
  // doesn't spin up an HTTP listener every activation. PairingService
  // calls this through the panel's `onPaired` listener; here we also
  // arm it for the next pair that happens while the panel is closed.
  PairingService.getInstance().addListener({
    onPaired: () => {
      void AgentOutputMonitor.getInstance().safeStartup(context);
    },
  });

  // Telemetry — opt-out via VS Code's global telemetry switch OR the
  // `codeagent-mobile.telemetryEnabled` setting OR `CODEAM_TELEMETRY=0`.
  // initTelemetry() returns false on opt-out + when no API key was
  // baked into the build; every subsequent capture() call is then a
  // no-op so the wiring below is safe to leave in.
  if (initTelemetry()) {
    capture('plugin_activated', { surface: 'vscode' });
    PairingService.getInstance().addListener({
      onPaired: () => {
        const u = PairingService.getInstance().pairedUser;
        if (u) {
          identifyUser({
            userId: u.email, // backend userId not yet exposed to the plugin
            email: u.email,
            name: u.name,
            plan: u.plan,
          });
        }
        capture('plugin_paired', { plan: u?.plan ?? 'unknown' });
      },
    });
  }

  log.appendLine('CodeAgent Mobile extension activated');
}

export function deactivate(): void {
  log?.appendLine('CodeAgent Mobile extension deactivating...');
  void shutdownTelemetry();

  try {
    CommandRelayService.getInstance().reportOffline();
    CommandRelayService.getInstance().stopPolling();
  } catch { /* not initialized */ }

  try {
    AgentOutputMonitor.getInstance().dispose();
  } catch { /* not initialized */ }

  try {
    panelProvider?.stopFileWatcher();
  } catch { /* not initialized */ }
  panelProvider = null;

  log?.appendLine('CodeAgent Mobile extension deactivated');
}

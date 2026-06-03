import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SettingsService } from '../services/settings.service';
import { FileOpsService } from '../services/file-ops.service';
import { ProjectOpsService } from '../services/project-ops.service';
import { TerminalOpsService } from '../services/terminal-ops.service';
import { PairingService } from '../services/pairing.service';
import { CommandRelayService, RemoteCommand, CommandListener } from '../services/command-relay.service';
import { IdeIntegrationService } from '../services/ide-integration.service';
import { AgentOutputMonitor } from '../services/agent-output-monitor';
import { CopilotChatService } from '../services/copilot-chat.service';
import { AgentStrategyRegistry } from '../services/strategies/AgentStrategyRegistry';
import type { AgentInvocation } from '../services/strategies/AgentStrategy';
import { ChatHistoryService } from '../services/chat-history.service';
import { McpConfigWriterService, McpConfigureRequest, McpEntry } from '../services/mcp-config-writer.service';
import { FileWatcherService } from '../services/file-watcher.service';
import { Messages } from '../ui/messages';
import { StatusBar } from '../ui/status-bar';
import { buildInstallAndRun as buildInstallAndRunPure } from '../utils/build-install-command';
import {
  generateNonce,
  renderPairingQrSvg,
  sanitizeSessionId,
} from '../utils/webview-security';
import { renderPanelHtml } from './panel-html';
import { RemoteCommandRouter } from './remote-command-router';

/**
 * Thin adapter that hands the pure builder VS Code's view of the
 * current shell + platform. Pure logic lives in
 * `utils/build-install-command.ts` so the CI matrix can hit it on
 * both ubuntu-latest and windows-latest without booting an
 * extension host.
 */
function buildInstallAndRun(subcommand: string): string {
  return buildInstallAndRunPure(
    subcommand,
    vscode.env.shell || '',
    process.platform === 'win32',
  );
}

export class ControllerPanelProvider implements vscode.WebviewViewProvider, CommandListener {
  public static readonly viewType = 'codeagent-mobile.panel';
  private view?: vscode.WebviewView;
  private log: vscode.OutputChannel;
  private nonce = generateNonce();
  /**
   * Per-pairing file watcher. Emits `/api/files/changed` +
   * `/api/review/hunks` so the mobile shows live edit hunks while
   * an in-IDE agent (Copilot Chat, JCEF observers) is active.
   * Started when pairing completes; stopped on disconnect or
   * extension teardown.
   */
  private fileWatcher: FileWatcherService | null = null;
  private readonly router: RemoteCommandRouter;

  constructor(
    private readonly extensionUri: vscode.Uri,
    log: vscode.OutputChannel,
  ) {
    this.log = log;
    this.router = new RemoteCommandRouter(log);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    this.nonce = generateNonce();
    webviewView.webview.html = this.getHtmlContent(webviewView.webview, this.nonce);

    webviewView.webview.onDidReceiveMessage((msg) => {
      this.handleWebviewMessage(msg);
    });

    CommandRelayService.getInstance().addListener(this);
    // Push a fresh status to the webview whenever the relay's
    // connection state changes — the panel renders the amber
    // "Reconnecting" dot from this signal.
    CommandRelayService.getInstance().onConnectionChange(() => {
      this.updateStatus();
    });

    PairingService.getInstance().addListener({
      onPaired: async (sessionId: string) => {
        this.log.appendLine(`Paired to session: ${sessionId}`);
        const relay = CommandRelayService.getInstance();
        relay.startPolling();
        this.startFileWatcher(sessionId);
        const agents = await IdeIntegrationService.getInstance().detectInstalledAgents();
        relay.reportAgents(
          agents.map((a) => ({
            id: a.id,
            name: a.name,
            icon: a.icon,
            installed: a.installed,
            isTerminalAgent: a.isTerminalAgent,
          })),
        );
        StatusBar.getInstance().reportAgents(agents);
        this.postMessage({
          type: 'agents',
          agents: agents.map((a) => ({ id: a.id, name: a.name, icon: a.icon })),
        });
        this.updateStatus();
        this.sendRecentSessions();
        if (SettingsService.getInstance().showNotifications) {
          vscode.window.showInformationMessage(
            Messages.ConnectedTo(PairingService.getInstance().pairedUser?.email || 'user'),
          );
        }

        // Proactively prime VS Code Chat consent so the first prompt from
        // mobile doesn't have a confusing pause waiting for a dialog.
        CopilotChatService.getInstance().primeConsent().catch((e) => {
          this.log.appendLine(`primeConsent error: ${e}`);
        });

        // Push existing LM chat history to the API so the mobile "Sessions"
        // screen immediately shows past VS Code Chat conversations alongside
        // Claude Code sessions (if any).
        ChatHistoryService.getInstance().pushSessions().catch((e) => {
          this.log.appendLine(`pushSessions error: ${e}`);
        });

        // After the first successful LM request, re-detect agents so the
        // mobile app sees the real model name (e.g. "VS Code Chat (GPT-4.1)"
        // instead of just "VS Code Chat") — consent has now been granted.
        CopilotChatService.getInstance().onFirstSuccess(async () => {
          const ide = IdeIntegrationService.getInstance();
          ide.clearCache();
          const fresh = await ide.detectInstalledAgents();
          CommandRelayService.getInstance().reportAgents(
            fresh.map((a) => ({
              id: a.id,
              name: a.name,
              icon: a.icon,
              installed: a.installed,
              isTerminalAgent: a.isTerminalAgent,
            })),
          );
          StatusBar.getInstance().reportAgents(fresh);
          this.postMessage({
            type: 'agents',
            agents: fresh.map((a) => ({ id: a.id, name: a.name, icon: a.icon })),
          });
          this.log.appendLine('Re-reported agents after first LM success (model name resolved)');
        });
      },
    });

    this.updateStatus();
  }

  onCommandReceived(command: RemoteCommand): void {
    this.router.dispatch(command);
  }

  private async handleWebviewMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'requestPairingCode':
        await this.handleRequestPairingCode();
        break;
      case 'disconnect':
        this.handleDisconnect();
        break;
      case 'refreshAgents':
        this.handleRefreshAgents();
        break;
      case 'copyInstallCommand':
        await this.handleCopyInstallCommand();
        break;
      case 'getStatus':
        this.updateStatus();
        this.sendRecentSessions();
        break;
      case 'reconnect': {
        const sessionId = sanitizeSessionId(msg.sessionId);
        if (sessionId) this.handleReconnect(sessionId);
        break;
      }
      case 'deleteSession': {
        const sessionId = sanitizeSessionId(msg.sessionId);
        if (sessionId) this.handleDeleteSession(sessionId);
        break;
      }
    }
  }

  private async handleRequestPairingCode(): Promise<void> {
    const pairing = PairingService.getInstance();
    const result = await pairing.requestPairingCode();
    if (result) {
      let qrSvg: string;
      try {
        qrSvg = await renderPairingQrSvg(result.code);
      } catch (err) {
        this.log.appendLine(`QR render failed: ${err}`);
        qrSvg = '';
      }
      this.postMessage({
        type: 'pairingCode',
        code: result.code,
        expiresAt: result.expiresAt,
        qrSvg,
      });
    } else {
      this.postMessage({ type: 'error', message: 'Failed to generate pairing code' });
    }
  }

  private sendRecentSessions(): void {
    const settings = SettingsService.getInstance();
    const sessions = settings.getRecentSessions();
    this.postMessage({ type: 'recentSessions', sessions });
  }

  private async handleReconnect(sessionId: string): Promise<void> {
    const settings = SettingsService.getInstance();
    const pairing = PairingService.getInstance();
    const relay = CommandRelayService.getInstance();
    const pluginId = settings.ensurePluginId();

    try {
      const result = await relay.postJson(`${settings.apiBaseUrl}/api/pairing/reconnect`, {
        pluginId,
        sessionId,
      });

      const success = (result as Record<string, unknown>)?.success as boolean;
      if (success) {
        const data = (result as Record<string, unknown>)?.data as Record<string, unknown>;
        const userObj = data?.user as Record<string, unknown> | undefined;
        const recentSessions = settings.getRecentSessions();
        const cached = recentSessions.find((s) => s.sessionId === sessionId);

        pairing.onReconnected(sessionId, {
          name: (userObj?.name as string) || cached?.userName || '',
          email: (userObj?.email as string) || cached?.userEmail || '',
          plan: (userObj?.plan as string) || cached?.userPlan || 'FREE',
          currentPeriodEnd: userObj?.currentPeriodEnd as string | undefined,
        });
        this.log.appendLine(`Reconnected to session: ${sessionId}`);
      } else {
        this.postMessage({ type: 'error', message: 'Session expired. Please generate a new code.' });
      }
    } catch (e) {
      this.log.appendLine(`Reconnect error: ${e}`);
      this.postMessage({ type: 'error', message: 'Failed to reconnect. Session may have expired.' });
    }
  }

  private async handleDeleteSession(sessionId: string): Promise<void> {
    const settings = SettingsService.getInstance();
    const url = `${settings.apiBaseUrl}/api/pairing/sessions/${sessionId}`;

    try {
      const urlObj = new URL(url);
      const transport = urlObj.protocol === 'https:' ? await import('https') : await import('http');
      await new Promise<void>((resolve, reject) => {
        const req = transport.request(
          { hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname, method: 'DELETE', timeout: 10000 },
          (res) => { res.on('data', () => {}); res.on('end', resolve); },
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
    } catch (e) {
      this.log.appendLine(`Delete session API error (non-critical): ${e}`);
    }

    settings.removeRecentSession(sessionId);
    this.sendRecentSessions();
    this.log.appendLine(`Deleted session: ${sessionId}`);
  }

  private handleDisconnect(): void {
    const relay = CommandRelayService.getInstance();
    relay.reportOffline();
    relay.stopPolling();
    this.stopFileWatcher();
    PairingService.getInstance().clearCurrentSession();
    this.updateStatus();
    this.log.appendLine('Disconnected');
  }

  /**
   * Spin up the per-pairing file watcher. Called from `onPaired`
   * (after the per-pairing `pluginAuthToken` is persisted) and from
   * the `reconnect` flow via the same pairing listener. Idempotent —
   * if a previous watcher is still running we tear it down first so
   * the next session emits with the fresh sessionId / token.
   */
  private startFileWatcher(sessionId: string): void {
    this.stopFileWatcher();

    const settings = SettingsService.getInstance();
    const token = settings.getPluginAuthToken();
    if (!token) {
      this.log.appendLine(
        '[fileWatcher] no pluginAuthToken — skipping start (legacy pairing flow?)',
      );
      return;
    }

    try {
      this.fileWatcher = new FileWatcherService({
        sessionId,
        pluginId: settings.ensurePluginId(),
        pluginAuthToken: token,
        apiBaseUrl: settings.apiBaseUrl,
        log: this.log,
      });
      this.fileWatcher.start();
    } catch (e) {
      this.log.appendLine(`[fileWatcher] start failed: ${e}`);
      this.fileWatcher = null;
    }
  }

  /**
   * Public so `extension.deactivate()` and `handleDisconnect()` can
   * both call it without reaching into private state. Idempotent.
   */
  public stopFileWatcher(): void {
    if (!this.fileWatcher) return;
    try {
      this.fileWatcher.stop();
    } catch (e) {
      this.log.appendLine(`[fileWatcher] stop threw: ${e}`);
    }
    this.fileWatcher = null;
  }

  private async handleRefreshAgents(): Promise<void> {
    const ide = IdeIntegrationService.getInstance();
    ide.clearCache();
    const agents = await ide.detectInstalledAgents();
    CommandRelayService.getInstance().reportAgents(
      agents.map((a) => ({
        id: a.id,
        name: a.name,
        icon: a.icon,
        installed: a.installed,
        isTerminalAgent: a.isTerminalAgent,
      })),
    );
    StatusBar.getInstance().reportAgents(agents);
    this.postMessage({
      type: 'agents',
      agents: agents.map((a) => ({ id: a.id, name: a.name, icon: a.icon })),
    });
  }

  private async handleCopyInstallCommand(): Promise<void> {
    const cmd = 'npm install -g @anthropic-ai/claude-code';
    await vscode.env.clipboard.writeText(cmd);
    vscode.window.showInformationMessage(`Copied: ${cmd}`);
  }

  private updateStatus(): void {
    const pairing = PairingService.getInstance();
    const relay = CommandRelayService.getInstance();

    this.postMessage({
      type: 'status',
      connected: relay.isPolling,
      // Three-state surface: online (SSE active), reconnecting
      // (SSE dropped, on polling fallback), offline (no transport
      // succeeded for 60s). The webview renders the dot color and
      // label from this field.
      connectionState: relay.isPolling ? relay.getConnectionState() : 'offline',
      // Powers the footer status strip's "Last sync: 3s ago" text.
      // Null when no transport has succeeded yet this session.
      lastSyncMs: relay.getLastSuccessfulSyncMs(),
      sessionId: pairing.currentSessionId,
      user: pairing.pairedUser
        ? {
            name: pairing.pairedUser.name,
            email: pairing.pairedUser.email,
            plan: pairing.pairedUser.plan,
          }
        : null,
    });
  }

  private postMessage(msg: Record<string, unknown>): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtmlContent(webview: vscode.Webview, nonce: string): string {
    return renderPanelHtml(webview, this.extensionUri, nonce);
  }
}

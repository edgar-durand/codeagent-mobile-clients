import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SettingsService } from '../services/settings.service';
import { FileOpsService } from '../services/file-ops.service';
import { PairingService } from '../services/pairing.service';
import { CommandRelayService, RemoteCommand, CommandListener } from '../services/command-relay.service';
import { WebSocketService } from '../services/websocket.service';
import { IdeIntegrationService } from '../services/ide-integration.service';
import { AgentBridgeService } from '../services/agent-bridge.service';
import { AgentOutputMonitor } from '../services/agent-output-monitor';
import { TerminalAgentService } from '../services/terminal-agent.service';
import { CopilotChatService } from '../services/copilot-chat.service';
import { ChatHistoryService } from '../services/chat-history.service';
import { ClaudeContextService } from '../services/claude-context.service';
import { McpConfigWriterService, McpConfigureRequest, McpEntry } from '../services/mcp-config-writer.service';

export class ControllerPanelProvider implements vscode.WebviewViewProvider, CommandListener {
  public static readonly viewType = 'codeagent-mobile.panel';
  private view?: vscode.WebviewView;
  private log: vscode.OutputChannel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    log: vscode.OutputChannel,
  ) {
    this.log = log;
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

    webviewView.webview.html = this.getHtmlContent();

    webviewView.webview.onDidReceiveMessage((msg) => {
      this.handleWebviewMessage(msg);
    });

    CommandRelayService.getInstance().addListener(this);

    PairingService.getInstance().addListener({
      onPaired: async (sessionId: string) => {
        this.log.appendLine(`Paired to session: ${sessionId}`);
        const relay = CommandRelayService.getInstance();
        relay.startPolling();
        const agents = await IdeIntegrationService.getInstance().detectInstalledAgents();
        relay.reportAgents(
          agents.map((a) => ({
            id: a.id,
            name: a.name,
            icon: a.icon,
            installed: a.installed,
          })),
        );
        this.postMessage({
          type: 'agents',
          agents: agents.map((a) => ({ id: a.id, name: a.name, icon: a.icon })),
        });
        this.updateStatus();
        this.sendRecentSessions();
        if (SettingsService.getInstance().showNotifications) {
          vscode.window.showInformationMessage(
            `CodeAgent Mobile: Connected to ${PairingService.getInstance().pairedUser?.email || 'user'}`,
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
            fresh.map((a) => ({ id: a.id, name: a.name, icon: a.icon, installed: a.installed })),
          );
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
    this.handleCommand(command);
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
      case 'getStatus':
        this.updateStatus();
        this.sendRecentSessions();
        break;
      case 'reconnect':
        this.handleReconnect(msg.sessionId as string);
        break;
      case 'deleteSession':
        this.handleDeleteSession(msg.sessionId as string);
        break;
    }
  }

  /** Whether an agentId identifies a Claude Code terminal agent. */
  private isClaudeAgent(agentId: string | undefined): boolean {
    if (!agentId) return false;
    const lower = agentId.toLowerCase();
    return (
      lower.includes('claude') ||
      lower.includes('anthropic') ||
      lower.startsWith('__terminal__:')
    );
  }

  private async handleRequestPairingCode(): Promise<void> {
    const pairing = PairingService.getInstance();
    const result = await pairing.requestPairingCode();
    if (result) {
      this.postMessage({ type: 'pairingCode', code: result.code, expiresAt: result.expiresAt });
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
    WebSocketService.getInstance().disconnect();
    PairingService.getInstance().clearCurrentSession();
    this.updateStatus();
    this.log.appendLine('Disconnected');
  }

  private async handleRefreshAgents(): Promise<void> {
    const ide = IdeIntegrationService.getInstance();
    ide.clearCache();
    const agents = await ide.detectInstalledAgents();
    CommandRelayService.getInstance().reportAgents(
      agents.map((a) => ({ id: a.id, name: a.name, icon: a.icon, installed: a.installed })),
    );
    this.postMessage({
      type: 'agents',
      agents: agents.map((a) => ({ id: a.id, name: a.name, icon: a.icon })),
    });
  }

  private handleCommand(command: RemoteCommand): void {
    const relay = CommandRelayService.getInstance();
    const ide = IdeIntegrationService.getInstance();

    switch (command.type) {
      case 'start_task':
      case 'send_prompt': {
        let prompt = (command.payload.prompt as string) || '';
        const agentId = command.payload.agentId as string | undefined;
        const sessionId = command.sessionId;

        // Handle file attachments — save to temp, append @filepath to prompt
        const files = command.payload.files as Array<{ filename: string; mimeType: string; base64: string }> | undefined;
        const tempPaths: string[] = [];
        if (files && files.length > 0) {
          for (const f of files) {
            const tmpPath = path.join(os.tmpdir(), `codeagent-${Date.now()}-${f.filename}`);
            fs.writeFileSync(tmpPath, Buffer.from(f.base64, 'base64'));
            tempPaths.push(tmpPath);
            prompt = `@${tmpPath} ${prompt}`;
          }
          // Clean up temp files after 2 min
          setTimeout(() => { tempPaths.forEach((p) => { try { fs.unlinkSync(p); } catch {} }); }, 120000);
        }

        vscode.window.showInformationMessage(`CodeAgent: Prompt received → ${prompt.substring(0, 60)}${prompt.length > 60 ? '...' : ''}`);

        // Route: VS Code Chat (Copilot via vscode.lm) — stream tokens back over relay.
        if (agentId?.startsWith('__vscode_lm__:')) {
          const copilot = CopilotChatService.getInstance();

          // Intercept "/model <id>" — used by the mobile's model picker as
          // a portable way to switch models across agents. For LM agents
          // we handle it as a preference update (no real prompt sent).
          const modelSwitch = /^\/model\s+(\S+)\s*$/.exec(prompt.trim());
          if (modelSwitch) {
            const newId = modelSwitch[1];
            copilot.setPreferredModel(newId);
            relay.sendResult(command.id, 'completed', {
              message: `Model preference set to ${newId}`,
              modelSwitch: true,
              modelId: newId,
            });
            // Trigger a re-detect so the mobile sees updated model label.
            const ide = IdeIntegrationService.getInstance();
            ide.clearCache();
            ide.detectInstalledAgents().then((fresh) => {
              relay.reportAgents(
                fresh.map((a) => ({ id: a.id, name: a.name, icon: a.icon, installed: a.installed })),
              );
            });
            break;
          }

          const modelFromPayload = command.payload.model as string | undefined;
          copilot.sendPrompt(prompt, sessionId, modelFromPayload).then((sent) => {
            relay.sendResult(command.id, sent ? 'completed' : 'failed', {
              message: sent ? 'Prompt streamed via Copilot' : 'Copilot request failed',
              sent,
            });
          });
          break;
        }

        ide.sendPromptToAgent(prompt, agentId).then(async (sent) => {
          relay.sendResult(command.id, 'completed', {
            message: sent ? 'Prompt sent to AI agent' : 'Prompt copied to clipboard',
            sent,
          });

          if (sent) {
            const agents = await ide.detectInstalledAgents();
            const target = agentId
              ? agents.find((a) => a.id === agentId)
              : agents.find((a) => a.isTerminalAgent) || agents[0];
            const isTerminal = target?.isTerminalAgent || agentId?.startsWith('__terminal__:');

            if (isTerminal) {
              TerminalAgentService.getInstance().startMonitoring(sessionId, prompt);
            } else {
              const monitor = AgentOutputMonitor.getInstance();
              monitor.startMonitoring(sessionId, prompt);
            }
          }
        });
        break;
      }

      case 'list_agents': {
        ide.clearCache();
        ide.detectInstalledAgents().then((agents) => {
          relay.sendResult(command.id, 'completed', {
            agents: agents.map((a) => ({ id: a.id, name: a.name, icon: a.icon, installed: a.installed })),
          });
        });
        break;
      }

      case 'list_models': {
        // Route by agentId so the mobile model picker shows options
        // relevant to the actually-selected agent. Copilot's vscode.lm
        // models are not accepted by Claude Code's /model command, and
        // vice versa — mixing them would break the picker.
        const requestedAgent = (command.payload as Record<string, unknown>)?.agentId as string | undefined;
        if (this.isClaudeAgent(requestedAgent)) {
          relay.sendResult(command.id, 'completed', {
            models: ClaudeContextService.getInstance().listModels(),
          });
          break;
        }
        CopilotChatService.getInstance().listAvailableModels().then((models) => {
          relay.sendResult(command.id, 'completed', { models });
        }).catch((e) => {
          this.log.appendLine(`list_models error: ${e}`);
          relay.sendResult(command.id, 'completed', { models: [] });
        });
        break;
      }

      case 'approve_action': {
        AgentBridgeService.getInstance().approveCurrentAction();
        relay.sendResult(command.id, 'completed', { message: 'Action approved' });
        break;
      }

      case 'reject_action': {
        AgentBridgeService.getInstance().rejectCurrentAction();
        relay.sendResult(command.id, 'completed', { message: 'Action rejected' });
        break;
      }

      case 'stop_task':
      case 'cancel_task': {
        AgentBridgeService.getInstance().cancelCurrentTask();
        AgentOutputMonitor.getInstance().stopMonitoring();
        TerminalAgentService.getInstance().stopMonitoring();
        relay.sendResult(command.id, 'completed', { message: 'Task cancelled' });
        break;
      }

      case 'provide_input': {
        const input = (command.payload.input as string) || '';
        AgentBridgeService.getInstance().provideInput(input);
        ide.sendPromptToAgent(input);
        relay.sendResult(command.id, 'completed', { message: 'Input provided' });
        break;
      }

      case 'select_option': {
        const targetIndex = (command.payload.index as number) ?? 0;
        const currentIndex = (command.payload.currentIndex as number) ?? 0;
        const terminal = TerminalAgentService.getInstance();
        terminal.selectOption(targetIndex, currentIndex).then((ok) => {
          relay.sendResult(command.id, ok ? 'completed' : 'failed', {
            message: ok ? `Selected option ${targetIndex}` : 'Claude Code terminal not found',
          });
        });
        break;
      }

      case 'escape_key': {
        const ok = TerminalAgentService.getInstance().sendEscape();
        relay.sendResult(command.id, ok ? 'completed' : 'failed', {
          message: ok ? 'Escape sent' : 'Claude Code terminal not found',
        });
        break;
      }

      case 'get_context': {
        const requestedAgent = (command.payload as Record<string, unknown>)?.agentId as string | undefined;

        // Claude Code terminal agent: report the same shape codeam-cli
        // produces (used/total/percent/model/outputTokens/cacheReadTokens/
        // monthlyCost/rateLimitReset/quotaPercent) by reading Claude's
        // own .jsonl session log. This is what mobile's quota/usage UI
        // expects, including the weekly-quota reset string.
        if (this.isClaudeAgent(requestedAgent)) {
          try {
            const snapshot = ClaudeContextService.getInstance().getContextSnapshot();
            relay.sendResult(command.id, 'completed', snapshot as unknown as Record<string, unknown>);
          } catch (e) {
            this.log.appendLine(`get_context (claude) error: ${e}`);
            relay.sendResult(command.id, 'completed', {
              used: 0, total: 0, percent: 0, model: null,
              outputTokens: 0, cacheReadTokens: 0, monthlyCost: 0,
              error: 'No Claude usage data yet — run a prompt first',
            });
          }
          break;
        }

        // VS Code Chat (Copilot via vscode.lm) fallback.
        CopilotChatService.getInstance().getContextSnapshot().then((snapshot) => {
          relay.sendResult(command.id, 'completed', snapshot as unknown as Record<string, unknown>);
        }).catch((e) => {
          this.log.appendLine(`get_context error: ${e}`);
          relay.sendResult(command.id, 'completed', {
            used: 0, total: 0, percent: 0, model: null,
            outputTokens: 0, cacheReadTokens: 0,
            error: 'Context tracking not available via IDE plugin — use codeam-cli for full usage data',
          });
        });
        break;
      }

      case 'resume_session': {
        const sessionCid = (command.payload as Record<string, unknown>).id as string | undefined;
        const auto = (command.payload as Record<string, unknown>).auto as boolean | undefined;
        if (!sessionCid) {
          relay.sendResult(command.id, 'failed', { error: 'Missing session id' });
          break;
        }

        // LM chat sessions: switch the in-memory current pointer, POST
        // the conversation to the API, then emit the CLI-compatible
        // resume signal (clear + new_turn with resumedSessionId) over
        // SSE so mobile/web auto-refetch the conversation instead of
        // requiring a manual page refresh.
        const history = ChatHistoryService.getInstance();
        if (history.getSession(sessionCid)) {
          history.setCurrentId(sessionCid);
          history.pushConversation(sessionCid)
            .then(() => history.pushSessions())
            .then(() => {
              CopilotChatService.getInstance().emitResumeSignal(
                command.sessionId,
                sessionCid,
              );
            })
            .finally(() => {
              relay.sendResult(command.id, 'completed', {
                message: `Resumed chat session ${sessionCid}`,
              });
            });
          break;
        }

        const resumePrompt = auto
          ? `--resume ${sessionCid} --dangerously-skip-permissions`
          : `--resume ${sessionCid}`;
        const terminal = TerminalAgentService.getInstance();
        // Kill current Claude and restart with --resume
        terminal.sendRawToTerminal('\x03'); // Ctrl+C
        setTimeout(() => {
          terminal.sendPromptToClaudeCode(resumePrompt).then((ok) => {
            relay.sendResult(command.id, ok ? 'completed' : 'failed', {
              message: ok ? `Resuming session ${sessionCid}` : 'Failed to launch Claude Code',
            });
          });
        }, 500);
        break;
      }

      case 'get_conversation': {
        const history = ChatHistoryService.getInstance();
        const id = history.getCurrentId();
        relay.sendResult(command.id, 'completed', { conversationId: id });
        break;
      }

      case 'list_sessions': {
        const history = ChatHistoryService.getInstance();
        history.pushSessions().finally(() => {
          relay.sendResult(command.id, 'completed', { sessions: history.listSessions() });
        });
        break;
      }

      case 'mcp_configure': {
        this.handleMcpConfigure(command, relay);
        break;
      }

      case 'mcp_status': {
        this.handleMcpStatus(command, relay);
        break;
      }

      case 'read_file': {
        const filePath = (command.payload as Record<string, unknown>)?.path as string | undefined;
        if (!filePath) {
          relay.sendResult(command.id, 'failed', { error: 'Missing path' });
          break;
        }
        FileOpsService.readFile(filePath).then((res: Record<string, unknown>) => {
          relay.sendResult(command.id, 'completed', res);
        });
        break;
      }

      case 'write_file': {
        const p = command.payload as Record<string, unknown>;
        const filePath = p?.path as string | undefined;
        const content = p?.content as string | undefined;
        if (!filePath || typeof content !== 'string') {
          relay.sendResult(command.id, 'failed', { error: 'Missing path or content' });
          break;
        }
        FileOpsService.writeFile(filePath, content).then((res: Record<string, unknown>) => {
          relay.sendResult(command.id, 'completed', res);
        });
        break;
      }

      default: {
        relay.sendResult(command.id, 'failed', {
          error: `Unknown command type: ${command.type}`,
        });
      }
    }
  }

  private handleMcpConfigure(command: RemoteCommand, relay: CommandRelayService): void {
    try {
      const payload = command.payload;
      const scope = (payload.scope as string) || 'global';
      const mcpsArray = (payload.mcps as Array<Record<string, unknown>>) || [];
      const targetAgents = payload.targetAgents as string[] | undefined;

      const mcps: McpEntry[] = mcpsArray.map((obj) => {
        const serverObj = obj.server as Record<string, unknown>;
        const envObj = (obj.env as Record<string, string>) || {};
        return {
          id: obj.id as string,
          server: {
            command: serverObj.command as string,
            args: serverObj.args as string[],
          },
          env: envObj,
        };
      });

      const request: McpConfigureRequest = { scope, mcps, targetAgents };
      const writer = McpConfigWriterService.getInstance();
      const results = writer.configure(request);

      relay.sendResult(command.id, 'completed', {
        message: `MCP configuration written for ${results.filter((r) => r.status === 'written').length} agents`,
        results,
      });
    } catch (e) {
      relay.sendResult(command.id, 'failed', {
        error: `MCP configuration failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  private handleMcpStatus(command: RemoteCommand, relay: CommandRelayService): void {
    try {
      const writer = McpConfigWriterService.getInstance();
      const configured = writer.getConfiguredMcps();

      const allMcpIds = new Set<string>();
      const agents: Array<{ agent: string; configFile: string; mcpIds: string[] }> = [];

      for (const info of configured) {
        info.mcpIds.forEach((id) => allMcpIds.add(id));
        agents.push({
          agent: info.agent,
          configFile: info.configFile,
          mcpIds: info.mcpIds,
        });
      }

      relay.sendResult(command.id, 'completed', {
        configuredMcpIds: Array.from(allMcpIds),
        agents,
      });
    } catch (e) {
      relay.sendResult(command.id, 'failed', {
        error: `Failed to read MCP status: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  private updateStatus(): void {
    const pairing = PairingService.getInstance();
    const relay = CommandRelayService.getInstance();
    const ws = WebSocketService.getInstance();

    this.postMessage({
      type: 'status',
      connected: relay.isPolling,
      wsConnected: ws.isConnected,
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

  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
      font-size: 13px;
    }
    .card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 10px;
    }
    .status-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dot-green { background: #22c55e; }
    .dot-red { background: #ef4444; }
    .dot-yellow { background: #eab308; }
    .label { font-weight: 600; }
    .muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .btn {
      display: block;
      width: 100%;
      padding: 8px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      margin-top: 8px;
    }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-danger {
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-errorForeground);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .pairing-code {
      font-size: 28px;
      font-weight: 700;
      text-align: center;
      letter-spacing: 6px;
      color: var(--vscode-textLink-foreground);
      padding: 12px;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 6px;
      margin: 8px 0;
    }
    .user-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .user-name { font-weight: 600; font-size: 14px; }
    .user-email { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .user-plan {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .agents-list { margin-top: 8px; }
    .agent-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 0;
      font-size: 12px;
    }
    .agent-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      flex-shrink: 0;
    }
    h3 {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    .hidden { display: none; }
    .expire-timer { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: center; }
    .qr-container { text-align: center; margin: 12px 0 8px; }
    .qr-container img { border-radius: 8px; background: #fff; padding: 8px; }
    .session-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      border-radius: 4px;
      margin-bottom: 4px;
    }
    .session-row:hover { background: var(--vscode-list-hoverBackground); }
    .session-info { flex: 1; min-width: 0; }
    .session-name { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .session-email { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .btn-reconnect {
      font-size: 10px;
      padding: 3px 8px;
      border: 1px solid var(--vscode-button-background);
      background: transparent;
      color: var(--vscode-button-background);
      border-radius: 3px;
      cursor: pointer;
      flex-shrink: 0;
      margin-left: 6px;
    }
    .btn-reconnect:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-delete {
      font-size: 10px;
      padding: 3px 6px;
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      background: transparent;
      color: var(--vscode-errorForeground);
      border-radius: 3px;
      cursor: pointer;
      flex-shrink: 0;
      margin-left: 4px;
      line-height: 1;
    }
    .btn-delete:hover { background: var(--vscode-inputValidation-errorBackground); }
  </style>
</head>
<body>
  <div id="disconnected-view">
    <div class="card">
      <div class="status-row">
        <div class="dot dot-red"></div>
        <span class="label">Disconnected</span>
      </div>
      <p class="muted">Pair your mobile device to control AI agents remotely.</p>
      <button class="btn btn-primary" onclick="requestPairing()">Generate Pairing Code</button>
    </div>

    <div id="pairing-section" class="card hidden">
      <h3>Pairing Code</h3>
      <div id="qr-container" class="qr-container"></div>
      <div id="pairing-code" class="pairing-code">------</div>
      <p id="pairing-timer" class="expire-timer">Waiting for connection...</p>
      <p class="muted" style="text-align:center; margin-top:6px;">Enter this code in your mobile app</p>
    </div>

    <div id="recent-sessions-section" class="card hidden">
      <h3>Recent Sessions</h3>
      <div id="recent-sessions-list"></div>
    </div>
  </div>

  <div id="connected-view" class="hidden">
    <div class="card">
      <div class="status-row">
        <div class="dot dot-green"></div>
        <span class="label">Connected</span>
      </div>
      <div class="user-info">
        <span id="user-name" class="user-name"></span>
        <span id="user-email" class="user-email"></span>
        <span id="user-plan" class="user-plan"></span>
      </div>
      <button class="btn btn-danger" onclick="disconnect()">Disconnect</button>
    </div>

    <div class="card">
      <h3>Detected AI Agents</h3>
      <div id="agents-list" class="agents-list">
        <p class="muted">Loading...</p>
      </div>
      <button class="btn btn-secondary" onclick="refreshAgents()">Refresh Agents</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let state = { connected: false, user: null, agents: [] };

    function requestPairing() {
      vscode.postMessage({ type: 'requestPairingCode' });
    }

    function disconnect() {
      vscode.postMessage({ type: 'disconnect' });
    }

    function refreshAgents() {
      vscode.postMessage({ type: 'refreshAgents' });
    }

    function reconnect(sessionId) {
      vscode.postMessage({ type: 'reconnect', sessionId: sessionId });
    }

    function deleteSession(sessionId) {
      vscode.postMessage({ type: 'deleteSession', sessionId: sessionId });
    }

    function renderRecentSessions(sessions) {
      const section = document.getElementById('recent-sessions-section');
      const list = document.getElementById('recent-sessions-list');
      if (!sessions || sessions.length === 0) {
        section.classList.add('hidden');
        return;
      }
      section.classList.remove('hidden');
      list.innerHTML = sessions.map(function(s) {
        var name = s.userName || s.userEmail || 'Unknown';
        var email = s.userName && s.userEmail ? s.userEmail : '';
        return '<div class="session-row">' +
          '<div class="session-info">' +
            '<div class="session-name">' + name + '</div>' +
            (email ? '<div class="session-email">' + email + '</div>' : '') +
          '</div>' +
          '<button class="btn-reconnect" data-sid="' + s.sessionId + '">Reconnect</button>' +
          '<button class="btn-delete" data-sid="' + s.sessionId + '" title="Delete session">✕</button>' +
        '</div>';
      }).join('');
      list.querySelectorAll('.btn-reconnect').forEach(function(btn) {
        btn.addEventListener('click', function() {
          reconnect(btn.getAttribute('data-sid'));
        });
      });
      list.querySelectorAll('.btn-delete').forEach(function(btn) {
        btn.addEventListener('click', function() {
          deleteSession(btn.getAttribute('data-sid'));
        });
      });
    }

    function updateUI() {
      const dv = document.getElementById('disconnected-view');
      const cv = document.getElementById('connected-view');

      if (state.connected) {
        dv.classList.add('hidden');
        cv.classList.remove('hidden');

        if (state.user) {
          document.getElementById('user-name').textContent = state.user.name || 'User';
          document.getElementById('user-email').textContent = state.user.email || '';
          document.getElementById('user-plan').textContent = state.user.plan || 'FREE';
        }
      } else {
        dv.classList.remove('hidden');
        cv.classList.add('hidden');
      }
    }

    function renderAgents(agents) {
      const container = document.getElementById('agents-list');
      if (!agents || agents.length === 0) {
        container.innerHTML = '<p class="muted">No AI agents detected</p>';
        return;
      }
      container.innerHTML = agents.map(a =>
        '<div class="agent-row"><div class="agent-dot"></div><span>' + a.name + '</span></div>'
      ).join('');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'status':
          state.connected = msg.connected;
          state.user = msg.user;
          updateUI();
          break;
        case 'pairingCode': {
          const section = document.getElementById('pairing-section');
          section.classList.remove('hidden');
          document.getElementById('pairing-code').textContent = msg.code;
          const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(msg.code);
          document.getElementById('qr-container').innerHTML = '<img src="' + qrUrl + '" width="180" height="180" alt="QR Code" />';
          const timer = document.getElementById('pairing-timer');
          const expiresAt = msg.expiresAt;
          const interval = setInterval(() => {
            const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
            if (remaining <= 0) {
              clearInterval(interval);
              timer.textContent = 'Code expired. Generate a new one.';
              section.classList.add('hidden');
            } else {
              const min = Math.floor(remaining / 60);
              const sec = remaining % 60;
              timer.textContent = 'Expires in ' + min + ':' + String(sec).padStart(2, '0');
            }
          }, 1000);
          break;
        }
        case 'agents':
          renderAgents(msg.agents);
          break;
        case 'recentSessions':
          renderRecentSessions(msg.sessions);
          break;
        case 'error':
          break;
      }
    });

    vscode.postMessage({ type: 'getStatus' });
  </script>
</body>
</html>`;
  }
}

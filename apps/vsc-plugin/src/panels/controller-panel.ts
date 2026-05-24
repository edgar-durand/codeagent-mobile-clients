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
import { WebSocketService } from '../services/websocket.service';
import { IdeIntegrationService } from '../services/ide-integration.service';
import { AgentBridgeService } from '../services/agent-bridge.service';
import { AgentOutputMonitor } from '../services/agent-output-monitor';
import { TerminalAgentService } from '../services/terminal-agent.service';
import { CopilotChatService } from '../services/copilot-chat.service';
import { AgentStrategyRegistry } from '../services/strategies/AgentStrategyRegistry';
import type { AgentInvocation } from '../services/strategies/AgentStrategy';
import { ChatHistoryService } from '../services/chat-history.service';
import { ClaudeContextService } from '../services/claude-context.service';
import { McpConfigWriterService, McpConfigureRequest, McpEntry } from '../services/mcp-config-writer.service';
import { FileWatcherService } from '../services/file-watcher.service';
import { buildInstallAndRun as buildInstallAndRunPure } from '../utils/build-install-command';
import { generateNonce, cspMeta, renderPairingQrSvg } from '../utils/webview-security';
import { brandCssTokens } from '../ui/brand-tokens';

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

// Session IDs sent by the webview are echoes of UUIDs we previously
// stored in recentSessions. Reject anything that doesn't match the
// shape — the webview is a sandboxed iframe behind our CSP, but the
// downstream services treat sessionId as trusted input.
function sanitizeSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(raw)) return null;
  return raw;
}

export class ControllerPanelProvider implements vscode.WebviewViewProvider, CommandListener {
  public static readonly viewType = 'codeagent-mobile.panel';
  private view?: vscode.WebviewView;
  private log: vscode.OutputChannel;
  private nonce = generateNonce();
  /**
   * Per-pairing file watcher. Mirrors Path A (CLI) emission of
   * `/api/files/changed` + `/api/review/hunks` for Path B (direct
   * Claude spawn through `claude-pseudoterminal.ts`). Started when
   * pairing completes; stopped on disconnect or extension teardown.
   */
  private fileWatcher: FileWatcherService | null = null;

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

    this.nonce = generateNonce();
    webviewView.webview.html = this.getHtmlContent(webviewView.webview, this.nonce);

    webviewView.webview.onDidReceiveMessage((msg) => {
      this.handleWebviewMessage(msg);
    });

    CommandRelayService.getInstance().addListener(this);

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
    WebSocketService.getInstance().disconnect();
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

        // Handle file attachments — save to temp, append @filepath to prompt.
        // Bound each attachment: a 50 MB base64 blob would stall the
        // extension host on the sync decode + writeFileSync. 10 MB is the
        // same ceiling the mobile composer enforces today.
        const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
        const files = command.payload.files as Array<{ filename: string; mimeType: string; base64: string }> | undefined;
        const tempPaths: string[] = [];
        let oversizedAttachment: string | null = null;
        if (files && files.length > 0) {
          for (const f of files) {
            const approxBytes = Math.floor((f.base64.length * 3) / 4);
            if (approxBytes > MAX_ATTACHMENT_BYTES) {
              oversizedAttachment = `${f.filename} (${approxBytes} bytes > ${MAX_ATTACHMENT_BYTES})`;
              break;
            }
            const tmpPath = path.join(os.tmpdir(), `codeagent-${Date.now()}-${f.filename}`);
            fs.writeFileSync(tmpPath, Buffer.from(f.base64, 'base64'));
            tempPaths.push(tmpPath);
            prompt = `@${tmpPath} ${prompt}`;
          }
          if (oversizedAttachment) {
            // Best-effort cleanup of anything we already wrote before
            // hitting the oversized blob.
            tempPaths.forEach((p) => { try { fs.unlinkSync(p); } catch { /* ignore */ } });
            relay.sendResult(command.id, 'failed', {
              error: `Attachment too large: ${oversizedAttachment}`,
            });
            return;
          }
          // Clean up temp files after 2 min
          setTimeout(() => { tempPaths.forEach((p) => { try { fs.unlinkSync(p); } catch {} }); }, 120000);
        }

        vscode.window.showInformationMessage(`CodeAgent: Prompt received → ${prompt.substring(0, 60)}${prompt.length > 60 ? '...' : ''}`);

        // Intercept "/model <id>" for LM agents — the mobile's model
        // picker uses this as a portable cross-agent switch. For LM
        // agents it's a preference update, not a real prompt, so we
        // short-circuit before strategy dispatch.
        if (agentId?.startsWith('__vscode_lm__:')) {
          const modelSwitch = /^\/model\s+(\S+)\s*$/.exec(prompt.trim());
          if (modelSwitch) {
            const newId = modelSwitch[1];
            CopilotChatService.getInstance().setPreferredModel(newId);
            relay.sendResult(command.id, 'completed', {
              message: `Model preference set to ${newId}`,
              modelSwitch: true,
              modelId: newId,
            });
            ide.clearCache();
            ide.detectInstalledAgents().then((fresh) => {
              relay.reportAgents(
                fresh.map((a) => ({ id: a.id, name: a.name, icon: a.icon, installed: a.installed })),
              );
            });
            break;
          }
        }

        // Resolve the target agent so strategies can use the full
        // DetectedAgent (`isTerminalAgent`, etc.) instead of guessing
        // from the agentId string. Falls back to the agentId-only
        // path if detection fails or the requested agent isn't
        // currently installed — strategies still match by id prefix.
        ide.detectInstalledAgents()
          .then((agents) => {
            const target = agentId
              ? agents.find((a) => a.id === agentId)
              : agents.find((a) => a.isTerminalAgent) ?? agents[0];

            const invocation: AgentInvocation = {
              agent: target,
              agentId,
              prompt,
              sessionId,
              commandId: command.id,
              model: command.payload.model as string | undefined,
            };

            return AgentStrategyRegistry.getInstance(this.log).execute(invocation);
          })
          .then((result) => {
            relay.sendResult(
              command.id,
              result.delivered ? 'completed' : 'failed',
              { message: result.message, ...(result.extra ?? {}) },
            );
          })
          .catch((err) => {
            this.log.appendLine(`[handleCommand] strategy execute threw: ${err}`);
            relay.sendResult(command.id, 'failed', {
              message: 'Strategy execution failed',
              error: String(err),
            });
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

      case 'list_files': {
        const query = (command.payload as Record<string, unknown>)?.query as string | undefined;
        ProjectOpsService.listFiles(query).then((res) => {
          relay.sendResult(command.id, 'completed', res as unknown as Record<string, unknown>);
        });
        break;
      }
      case 'search_files': {
        const p = (command.payload ?? {}) as Record<string, unknown>;
        const query = p.query as string | undefined;
        if (!query) {
          relay.sendResult(command.id, 'failed', { error: 'Missing query' });
          break;
        }
        ProjectOpsService.searchFiles({
          query,
          caseSensitive: p.caseSensitive === true,
          wholeWord: p.wholeWord === true,
          regex: p.regex === true,
          include: Array.isArray(p.include) ? (p.include as string[]) : undefined,
          exclude: Array.isArray(p.exclude) ? (p.exclude as string[]) : undefined,
          maxResults: typeof p.maxResults === 'number' ? (p.maxResults as number) : undefined,
        }).then((res) => {
          relay.sendResult(command.id, 'completed', res as unknown as Record<string, unknown>);
        });
        break;
      }
      case 'terminal_open': {
        const p = (command.payload ?? {}) as Record<string, unknown>;
        // `command.sessionId` is the paired CodeAgent session — same
        // value `dispatchCommand` already binds to chunk emissions.
        const r = TerminalOpsService.getInstance().open(command.sessionId, {
          cols: typeof p.cols === 'number' ? (p.cols as number) : undefined,
          rows: typeof p.rows === 'number' ? (p.rows as number) : undefined,
          cwd: typeof p.cwd === 'string' ? (p.cwd as string) : undefined,
        });
        if ('error' in r) relay.sendResult(command.id, 'failed', { error: r.error });
        else relay.sendResult(command.id, 'completed', r as unknown as Record<string, unknown>);
        break;
      }
      case 'terminal_write': {
        const p = (command.payload ?? {}) as Record<string, unknown>;
        const ts = p.sessionId as string | undefined;
        const data = p.data as string | undefined;
        if (!ts || typeof data !== 'string') {
          relay.sendResult(command.id, 'failed', { error: 'Missing sessionId or data' });
          break;
        }
        const r = TerminalOpsService.getInstance().write(ts, data);
        relay.sendResult(command.id, r.ok ? 'completed' : 'failed', r as unknown as Record<string, unknown>);
        break;
      }
      case 'terminal_resize': {
        const p = (command.payload ?? {}) as Record<string, unknown>;
        const ts = p.sessionId as string | undefined;
        const cols = p.cols as number | undefined;
        const rows = p.rows as number | undefined;
        if (!ts || typeof cols !== 'number' || typeof rows !== 'number') {
          relay.sendResult(command.id, 'failed', { error: 'Missing sessionId / cols / rows' });
          break;
        }
        const r = TerminalOpsService.getInstance().resize(ts, cols, rows);
        relay.sendResult(command.id, r.ok ? 'completed' : 'failed', r as unknown as Record<string, unknown>);
        break;
      }
      case 'terminal_close': {
        const p = (command.payload ?? {}) as Record<string, unknown>;
        const ts = p.sessionId as string | undefined;
        if (!ts) {
          relay.sendResult(command.id, 'failed', { error: 'Missing sessionId' });
          break;
        }
        const r = TerminalOpsService.getInstance().close(ts);
        relay.sendResult(command.id, 'completed', r as unknown as Record<string, unknown>);
        break;
      }
      case 'git_status': {
        ProjectOpsService.gitStatus().then((res) => {
          relay.sendResult(command.id, 'completed', res);
        });
        break;
      }
      case 'git_diff': {
        const p = (command.payload as Record<string, unknown>)?.path as string | undefined;
        ProjectOpsService.gitDiff(p ?? null).then((res) => {
          relay.sendResult(command.id, 'completed', res as Record<string, unknown>);
        });
        break;
      }
      case 'git_diff_staged': {
        const p = (command.payload as Record<string, unknown>)?.path as string | undefined;
        ProjectOpsService.gitDiffStaged(p ?? null).then((res) => {
          relay.sendResult(command.id, 'completed', res as Record<string, unknown>);
        });
        break;
      }
      case 'git_log': {
        const limit = (command.payload as Record<string, unknown>)?.limit as number | undefined;
        ProjectOpsService.gitLog(limit ?? 30).then((res) => {
          relay.sendResult(command.id, 'completed', res as unknown as Record<string, unknown>);
        });
        break;
      }
      case 'git_commit': {
        const p = command.payload as Record<string, unknown>;
        const message = p?.message as string | undefined;
        const paths = p?.paths as string[] | undefined;
        if (!message) {
          relay.sendResult(command.id, 'failed', { error: 'Missing message' });
          break;
        }
        ProjectOpsService.gitCommit(message, paths).then((res) => {
          relay.sendResult(command.id, 'completed', res as Record<string, unknown>);
        });
        break;
      }
      case 'git_push': {
        ProjectOpsService.gitPush().then((res) => {
          relay.sendResult(command.id, 'completed', res as Record<string, unknown>);
        });
        break;
      }
      case 'git_pull': {
        ProjectOpsService.gitPull().then((res) => {
          relay.sendResult(command.id, 'completed', res as Record<string, unknown>);
        });
        break;
      }
      case 'git_resolve': {
        const p = command.payload as Record<string, unknown>;
        const filePath = p?.path as string | undefined;
        const side = p?.side as 'ours' | 'theirs' | undefined;
        if (!filePath || !side) {
          relay.sendResult(command.id, 'failed', { error: 'Missing path or side' });
          break;
        }
        ProjectOpsService.gitResolve(filePath, side).then((res) => {
          relay.sendResult(command.id, 'completed', res as Record<string, unknown>);
        });
        break;
      }

      case 'install_cli_and_pair': {
        // Open a terminal in the active workspace and pair with
        // `codeam-cli`. We try `codeam` first (works when the user
        // already installed it globally) and fall back to
        // `npx -y codeam-cli pair` — npx fetches the package on the
        // fly so the user doesn't need write access to the global
        // node_modules.
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const terminal = vscode.window.createTerminal({
          name: 'codeam pair',
          ...(folder ? { cwd: folder } : {}),
        });
        terminal.show(true);
        // Always install/upgrade codeam-cli to latest, THEN pair.
        // `npm install -g codeam-cli@latest` is idempotent — fast
        // no-op if already on the latest, real upgrade otherwise.
        // Chained with `&&` so pair only runs after a successful
        // install; the final `|| npx` fallback handles environments
        // where `npm i -g` would need sudo (npx fetches + runs
        // without touching the global node_modules).
        terminal.sendText(buildInstallAndRun('pair'));
        relay.sendResult(command.id, 'completed', {
          message: 'Terminal opened with codeam pair',
        });
        break;
      }

      case 'install_cli_and_link': {
        // Sibling of `install_cli_and_pair` for the `codeam link
        // <agent>` flow. Mobile sends this when the user taps "Continue
        // with OAuth" inside the Link Agent sheet and a plugin is
        // available (paired session with the IDE running). The terminal
        // opens, `codeam-cli` is auto-installed if missing, and
        // `codeam link <agent>` takes over from there — pair + capture
        // + upload — without the user touching anything beyond the
        // browser tab the agent's `<binary> login` opens.
        //
        // Payload: { agent: 'claude' | 'codex' } (defaults to 'claude').
        const linkAgent = (command.payload?.agent as string | undefined) ?? 'claude';
        const safeAgent = linkAgent === 'codex' ? 'codex' : 'claude';
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const terminal = vscode.window.createTerminal({
          name: `codeam link ${safeAgent}`,
          ...(folder ? { cwd: folder } : {}),
        });
        terminal.show(true);
        terminal.sendText(buildInstallAndRun(`link ${safeAgent}`));
        relay.sendResult(command.id, 'completed', {
          message: `Terminal opened with codeam link ${safeAgent}`,
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

  private getHtmlContent(webview: vscode.Webview, nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspMeta(webview, nonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    ${brandCssTokens()}
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
    .dot-green { background: var(--ca-success); box-shadow: 0 0 6px rgba(0, 255, 160, 0.6); }
    .dot-red { background: var(--ca-error); box-shadow: 0 0 6px rgba(255, 68, 68, 0.5); }
    .dot-yellow { background: var(--ca-warning); }
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
      background: var(--ca-purple);
      color: var(--ca-on-surface);
      box-shadow: 0 0 12px var(--ca-glow-purple);
    }
    .btn-primary:hover { filter: brightness(1.08); }
    .btn-primary:focus-visible {
      outline: 2px solid var(--ca-purple);
      outline-offset: 2px;
    }
    .btn-danger {
      background: var(--ca-error);
      color: var(--ca-on-surface);
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
      color: var(--ca-purple);
      padding: 12px;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 6px;
      margin: 8px 0;
      text-shadow: 0 0 14px var(--ca-glow-purple);
      font-family: var(--vscode-editor-font-family), monospace;
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
      <button id="btn-generate-pairing" class="btn btn-primary">Generate Pairing Code</button>
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
      <button id="btn-disconnect" class="btn btn-danger">Disconnect</button>
    </div>

    <div class="card">
      <h3>Detected AI Agents</h3>
      <div id="agents-list" class="agents-list">
        <p class="muted">Loading...</p>
      </div>
      <button id="btn-refresh-agents" class="btn btn-secondary">Refresh Agents</button>
    </div>
  </div>

  <script nonce="${nonce}">
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
          // SVG is rendered extension-side via the qrcode package and
          // arrives as a trusted string. We never load the pairing code
          // through a third-party host — it is a short-lived bearer
          // secret.
          const qr = document.getElementById('qr-container');
          if (msg.qrSvg) {
            qr.innerHTML = msg.qrSvg;
            const svg = qr.querySelector('svg');
            if (svg) {
              svg.setAttribute('width', '180');
              svg.setAttribute('height', '180');
              svg.setAttribute('aria-label', 'QR code for pairing code ' + msg.code);
            }
          } else {
            qr.innerHTML = '<p class="muted">QR unavailable — enter the code manually on your phone.</p>';
          }
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

    // Inline event handlers (onclick="...") are blocked by the webview's
    // CSP — wire buttons via addEventListener instead.
    document.getElementById('btn-generate-pairing').addEventListener('click', requestPairing);
    document.getElementById('btn-disconnect').addEventListener('click', disconnect);
    document.getElementById('btn-refresh-agents').addEventListener('click', refreshAgents);

    vscode.postMessage({ type: 'getStatus' });
  </script>
</body>
</html>`;
  }
}

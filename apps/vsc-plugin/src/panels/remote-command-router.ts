import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CommandRelayService, RemoteCommand } from '../services/command-relay.service';
import { IdeIntegrationService } from '../services/ide-integration.service';
import { TerminalOpsService } from '../services/terminal-ops.service';
import { FileOpsService } from '../services/file-ops.service';
import { ProjectOpsService } from '../services/project-ops.service';
import { ChatHistoryService } from '../services/chat-history.service';
import { AgentStrategyRegistry } from '../services/strategies/AgentStrategyRegistry';
import type { AgentInvocation, StrategyResult } from '../services/strategies/AgentStrategy';
import { CopilotChatService } from '../services/copilot-chat.service';
import { AgentOutputMonitor } from '../services/agent-output-monitor';
import {
  McpConfigWriterService,
  McpConfigureRequest,
  McpEntry,
} from '../services/mcp-config-writer.service';
import { Messages } from '../ui/messages';
import { buildInstallAndRun as buildInstallAndRunPure } from '../utils/build-install-command';
import { normalizeCliAgentId } from '../utils/cli-agent-id';

function buildInstallAndRun(subcommand: string): string {
  return buildInstallAndRunPure(
    subcommand,
    vscode.env.shell || '',
    process.platform === 'win32',
  );
}

const TERMINAL_AGENT_MESSAGE =
  'Terminal agents are run by codeam-cli. Install it (npm i -g codeam-cli) and run `codeam pair`.';

/**
 * Routes a single RemoteCommand to the right service. Extracted from
 * ControllerPanelProvider so the panel can stay focused on lifecycle
 * + UI state — this class owns the (~30-arm) dispatch switch and the
 * per-arm result emission via CommandRelayService.sendResult.
 *
 * The router holds no panel-specific state; it depends only on
 * vscode.OutputChannel for logging and the existing singleton
 * services. Adding a new command arm here doesn't require touching
 * the panel.
 */
export class RemoteCommandRouter {
  constructor(private readonly log: vscode.OutputChannel) {}

  dispatch(command: RemoteCommand): void {
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
          setTimeout(() => {
            tempPaths.forEach((p) => {
              try { fs.unlinkSync(p); }
              catch (e) { this.log.appendLine(`[cleanup] unlink ${p} failed: ${e}`); }
            });
          }, 120000);
        }

        const promptPreview = prompt.length > 60 ? `${prompt.substring(0, 60)}…` : prompt;
        vscode.window.showInformationMessage(Messages.PromptReceived(promptPreview));

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
                fresh.map((a) => ({
                  id: a.id,
                  name: a.name,
                  icon: a.icon,
                  installed: a.installed,
                  isTerminalAgent: a.isTerminalAgent,
                })),
              );
            });
            break;
          }
        }

        // Terminal-agent commands (Claude / Codex / Cursor / CodeRabbit
        // / Aider) are owned by codeam-cli — the mobile should dispatch
        // them to the CLI's pluginId, not the IDE plugin's. If one slips
        // through anyway, fail explicitly so the user sees a clear hint
        // instead of a silent observer-bridge no-op.
        if (agentId?.startsWith('__terminal__:')) {
          relay.sendResult(command.id, 'failed', {
            message: TERMINAL_AGENT_MESSAGE,
          });
          break;
        }
        if (agentId && normalizeCliAgentId(agentId)) {
          relay.sendResult(command.id, 'failed', {
            message: TERMINAL_AGENT_MESSAGE,
          });
          break;
        }

        // Resolve the target agent so strategies receive the full
        // DetectedAgent (Copilot Chat, JCEF observers, etc.). The plugin
        // no longer manages terminal agents, so default targeting picks
        // the first installed non-terminal entry.
        ide.detectInstalledAgents()
          .then((agents) => {
            const target = agentId
              ? agents.find((a) => a.id === agentId)
              : agents.find((a) => !a.isTerminalAgent) ?? agents[0];

            if (target?.isTerminalAgent) {
              const terminalResult: StrategyResult = {
                delivered: false,
                message: TERMINAL_AGENT_MESSAGE,
              };
              return terminalResult;
            }

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
        // The plugin only owns models for in-IDE LM surfaces (Copilot
        // via vscode.lm). Terminal agents (Claude / Codex / Cursor /
        // CodeRabbit / Aider) are owned by codeam-cli — list_models
        // for those agents is routed to the CLI's pluginId, not here.
        CopilotChatService.getInstance().listAvailableModels().then((models) => {
          relay.sendResult(command.id, 'completed', { models });
        }).catch((e) => {
          this.log.appendLine(`list_models error: ${e}`);
          relay.sendResult(command.id, 'completed', { models: [] });
        });
        break;
      }

      case 'approve_action': {
        // Approve / reject used to fan out to the legacy WebSocket
        // transport so an external observer could correlate the
        // decision with the live action stream. That transport is
        // dead — these are acks only now.
        this.log.appendLine('Command: approve_action');
        relay.sendResult(command.id, 'completed', { message: 'Action approved' });
        break;
      }

      case 'reject_action': {
        this.log.appendLine('Command: reject_action');
        relay.sendResult(command.id, 'completed', { message: 'Action rejected' });
        break;
      }

      case 'stop_task':
      case 'cancel_task': {
        // Stops JCEF / Lexical observer monitoring. Terminal agents
        // (Claude / Codex / …) are owned by codeam-cli, so a stop_task
        // for those agents is dispatched to the CLI's pluginId, not
        // here.
        AgentOutputMonitor.getInstance().stopMonitoring();
        relay.sendResult(command.id, 'completed', { message: 'Task cancelled' });
        break;
      }

      case 'provide_input': {
        const input = (command.payload.input as string) || '';
        ide.sendPromptToAgent(input);
        relay.sendResult(command.id, 'completed', { message: 'Input provided' });
        break;
      }

      case 'get_context': {
        // VS Code Chat (Copilot via vscode.lm) is the only context the
        // plugin owns. Terminal-agent quota / token snapshots come
        // from codeam-cli's own history reader, which the mobile
        // dispatches to the CLI's pluginId.
        CopilotChatService.getInstance().getContextSnapshot().then((snapshot) => {
          relay.sendResult(command.id, 'completed', snapshot);
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

        // Terminal-agent resume (Claude / Codex / …) is owned by
        // codeam-cli — mobile dispatches it to the CLI's pluginId.
        // If we reach here the requested session belongs to neither
        // a Copilot chat history nor a CLI session this plugin knows
        // about; surface the mismatch rather than silently no-op.
        void auto;
        relay.sendResult(command.id, 'failed', {
          error: `Unknown session id: ${sessionCid}`,
        });
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
          relay.sendResult(command.id, 'completed', res);
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
          relay.sendResult(command.id, 'completed', res);
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
        else relay.sendResult(command.id, 'completed', r);
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
        relay.sendResult(command.id, r.ok ? 'completed' : 'failed', r);
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
        relay.sendResult(command.id, r.ok ? 'completed' : 'failed', r);
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
        relay.sendResult(command.id, 'completed', r);
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
          relay.sendResult(command.id, 'completed', res);
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
        //
        // Optional payload: { agent: 'claude' | '__terminal__:claude_code' | ... }
        // or { agentId: ... }.
        // When the mobile/web surface knew which agent the user
        // wanted, normalize the picker id back to the CLI id so the
        // freshly-paired CLI session opens that agent directly.
        const pairAgentRaw = command.payload?.agent ?? command.payload?.agentId;
        const pairAgent = normalizeCliAgentId(pairAgentRaw);
        const subcommand = pairAgent ? `pair --agent=${pairAgent}` : 'pair';
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const terminal = vscode.window.createTerminal({
          name: pairAgent ? `codeam pair ${pairAgent}` : 'codeam pair',
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
        terminal.sendText(buildInstallAndRun(subcommand));
        relay.sendResult(command.id, 'completed', {
          message: pairAgent
            ? `Terminal opened with codeam pair --agent=${pairAgent}`
            : 'Terminal opened with codeam pair',
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

      case 'show_install_command': {
        // Backend pushes the self-hosted install one-liner the user
        // copies onto their own box. DISPLAY-ONLY — we show it in a
        // modal with a "Copy command" action and never execute it.
        const installCommand = (command.payload as Record<string, unknown>)?.command as
          | string
          | undefined;
        if (!installCommand) {
          relay.sendResult(command.id, 'failed', { error: 'Missing command' });
          break;
        }
        vscode.window
          .showInformationMessage(
            installCommand,
            { modal: true, detail: 'Copy this to set up your self-hosted box.' },
            'Copy command',
          )
          .then((choice) => {
            if (choice === 'Copy command') {
              vscode.env.clipboard.writeText(installCommand).then(() => {
                vscode.window.showInformationMessage('Install command copied to clipboard.');
              });
            }
          });
        relay.sendResult(command.id, 'completed', {
          message: 'Displayed self-hosted install command',
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

}

import * as vscode from 'vscode';
import type { OutputChannel } from 'vscode';
import type { AgentInvocation, AgentStrategy, StrategyResult } from './AgentStrategy';
import { normalizeCliAgentId } from '../../utils/cli-agent-id';

/**
 * Routes prompts for terminal-backed agents to the active VS Code
 * integrated terminal. This covers Claude Code/Codex sessions the user
 * already has open in VS Code when the backend addresses the IDE plugin
 * with a `__terminal__:*` agent id.
 */
export class TerminalAgentStrategy implements AgentStrategy {
  readonly name = 'TerminalAgentStrategy';

  constructor(private readonly log: OutputChannel) {}

  canHandle(invocation: AgentInvocation): boolean {
    const id = invocation.agentId;
    if (id?.startsWith('__terminal__:')) return true;
    if (id && normalizeCliAgentId(id)) return true;
    return invocation.agent?.isTerminalAgent === true;
  }

  async execute(invocation: AgentInvocation): Promise<StrategyResult> {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      this.log.appendLine(
        `[${this.name}] no active VS Code terminal for agentId=${invocation.agentId ?? '<none>'}`,
      );
      return {
        delivered: false,
        message: 'No active VS Code terminal is open for the selected terminal agent',
      };
    }

    terminal.show(false);
    terminal.sendText(invocation.prompt, true);
    const agentId = invocation.agentId ?? '<auto>';
    this.log.appendLine(
      `[${this.name}] delivered prompt to active terminal (agentId=${agentId})`,
    );
    return {
      delivered: true,
      message: 'Prompt sent to active VS Code terminal',
      extra: { sent: true, terminal: true },
    };
  }

  stop(): void {
    // VS Code Terminal writes are fire-and-forget; nothing to cancel.
  }
}

import type { OutputChannel } from 'vscode';
import type { AgentInvocation, AgentStrategy, StrategyResult } from './AgentStrategy';
import { TerminalAgentService } from '../terminal-agent.service';

/**
 * Routes Claude Code (terminal-based) prompts through the PTY-backed
 * `TerminalAgentService`. Matches when the detected agent is flagged
 * `isTerminalAgent`, or when the explicit `agentId` carries the
 * `__terminal__:` prefix (used by the mobile when it wants to pin
 * the terminal route even before agent detection has resolved).
 *
 * Stop tears down the PTY output monitor — the underlying terminal
 * process is owned by the user and is NOT killed here.
 */
export class TerminalClaudeCodeStrategy implements AgentStrategy {
  readonly name = 'TerminalClaudeCodeStrategy';

  constructor(private readonly log: OutputChannel) {}

  canHandle(invocation: AgentInvocation): boolean {
    if (invocation.agent?.isTerminalAgent === true) return true;
    if (invocation.agentId?.startsWith('__terminal__:') === true) return true;
    return false;
  }

  async execute(invocation: AgentInvocation): Promise<StrategyResult> {
    const service = TerminalAgentService.getInstance();
    const sent = await service.sendPromptToClaudeCode(invocation.prompt);
    if (!sent) {
      this.log.appendLine(
        `[${this.name}] sendPromptToClaudeCode returned false — falling through to next strategy`,
      );
      return { delivered: false, message: 'Terminal agent failed to accept prompt' };
    }
    service.startMonitoring(invocation.sessionId, invocation.prompt);
    return {
      delivered: true,
      message: 'Prompt sent to Claude Code terminal',
      extra: { sent: true },
    };
  }

  stop(): void {
    TerminalAgentService.getInstance().stopMonitoring();
  }
}

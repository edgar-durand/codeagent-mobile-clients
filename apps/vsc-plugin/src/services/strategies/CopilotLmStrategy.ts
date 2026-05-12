import type { OutputChannel } from 'vscode';
import type { AgentInvocation, AgentStrategy, StrategyResult } from './AgentStrategy';
import { CopilotChatService } from '../copilot-chat.service';

/**
 * Routes prompts addressed to Copilot's vscode.lm language-model
 * surface (`__vscode_lm__:...` agent ids). Delegates to
 * `CopilotChatService.sendPrompt`, which selects the right LM via
 * `vscode.lm.selectChatModels()`, streams the response tokens back
 * through the relay, and reports completion on its own — so this
 * strategy doesn't start a separate `AgentOutputMonitor`.
 *
 * Stop is a no-op: the underlying `vscode.lm` request finishes on
 * its own and the streaming cancellation token is managed inside
 * `CopilotChatService`.
 */
export class CopilotLmStrategy implements AgentStrategy {
  readonly name = 'CopilotLmStrategy';

  constructor(private readonly log: OutputChannel) {}

  canHandle(invocation: AgentInvocation): boolean {
    return invocation.agentId?.startsWith('__vscode_lm__:') === true;
  }

  async execute(invocation: AgentInvocation): Promise<StrategyResult> {
    const copilot = CopilotChatService.getInstance();
    const sent = await copilot.sendPrompt(invocation.prompt, invocation.sessionId, invocation.model);
    return {
      delivered: sent,
      message: sent ? 'Prompt streamed via Copilot' : 'Copilot request failed',
      extra: { sent },
    };
  }

  stop(): void {
    // vscode.lm streams terminate on their own. CopilotChatService
    // owns the per-request cancellation token internally.
  }
}

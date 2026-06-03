import type { OutputChannel } from 'vscode';
import type { AgentInvocation, AgentStrategy, StrategyResult } from './AgentStrategy';
import { CopilotChatService } from '../copilot-chat.service';

/**
 * Routes prompts addressed to Copilot's vscode.lm language-model
 * surface. Delegates to `CopilotChatService.sendPrompt`, which
 * selects the right LM via `vscode.lm.selectChatModels()`, streams
 * the response tokens back through the relay, and reports
 * completion on its own — so this strategy doesn't start a
 * separate `AgentOutputMonitor`.
 *
 * Matches both naming conventions:
 *   - `__vscode_lm__:<vendor>` — the canonical internal id the
 *     `VsCodeChatDetector` ships.
 *   - `github.copilot-chat` / `github.copilot` — the marketplace
 *     extension ids the `ExtensionOnlyDetector` registers. The
 *     observer-bridge fallback for these used to inject JS into
 *     `workbench.html`, which Microsoft now treats as tampering —
 *     the injection was removed for marketplace compliance
 *     (see `AgentOutputMonitor.cleanupWorkbenchInjectionOnce`)
 *     leaving Copilot Chat with no working dispatch path. The
 *     `vscode.lm` API surfaces the same underlying Copilot models
 *     without any DOM scraping, so we route these ids here.
 *
 * Stop is a no-op: the underlying `vscode.lm` request finishes on
 * its own and the streaming cancellation token is managed inside
 * `CopilotChatService`.
 */
export class CopilotLmStrategy implements AgentStrategy {
  readonly name = 'CopilotLmStrategy';

  // Lower-cased once at module load so the canHandle check is a
  // simple Set lookup per dispatch.
  private static readonly COPILOT_EXTENSION_IDS = new Set([
    'github.copilot-chat',
    'github.copilot',
  ]);

  constructor(private readonly log: OutputChannel) {}

  canHandle(invocation: AgentInvocation): boolean {
    const id = invocation.agentId?.toLowerCase();
    if (!id) return false;
    if (id.startsWith('__vscode_lm__:')) return true;
    return CopilotLmStrategy.COPILOT_EXTENSION_IDS.has(id);
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

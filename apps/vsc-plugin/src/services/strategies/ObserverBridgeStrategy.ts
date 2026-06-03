import * as vscode from 'vscode';
import type { OutputChannel } from 'vscode';
import type { AgentInvocation, AgentStrategy, StrategyResult } from './AgentStrategy';
import { Messages } from '../../ui/messages';

/**
 * Catch-all strategy for agents we have no native dispatch for —
 * Cursor (running outside VS Code), Windsurf, third-party
 * extensions that don't expose a `vscode.lm` model or a programmatic
 * "submit prompt" API.
 *
 * Historical context: this used to inject an observer script into
 * VS Code's `workbench.html` that scraped chat panels via DOM
 * mutations and POSTed the agent's reply back to a localhost
 * server. Microsoft's marketplace now treats workbench tampering as
 * grounds for removal (see `AgentOutputMonitor.cleanupWorkbenchInjectionOnce`),
 * so the injection path was deleted and the queue + monitor it
 * fed went silent. Pretending to dispatch (`queuePrompt` +
 * `startMonitoring`) just made the mobile UI hang on "Thinking…"
 * for the full 75 s `NO_CONTENT_TIMEOUT_MS` budget.
 *
 * Current behaviour: copy the prompt to the user's clipboard,
 * surface a single warning toast, and report `delivered: false`
 * upstream so the mobile chat doesn't claim the agent received the
 * prompt. The user pastes manually into the agent's UI — slower
 * but honest. Copilot Chat is routed through `CopilotLmStrategy`
 * via the `vscode.lm` API so it never hits this fallback.
 *
 * Always returns true from `canHandle`, so it MUST be registered
 * last in the registry.
 */
export class ObserverBridgeStrategy implements AgentStrategy {
  readonly name = 'ObserverBridgeStrategy';

  constructor(private readonly log: OutputChannel) {}

  canHandle(_invocation: AgentInvocation): boolean {
    return true;
  }

  async execute(invocation: AgentInvocation): Promise<StrategyResult> {
    try {
      await vscode.env.clipboard.writeText(invocation.prompt);
    } catch (e) {
      this.log.appendLine(`[${this.name}] clipboard write failed: ${e}`);
    }
    this.log.appendLine(
      `[${this.name}] No native dispatch for agentId=${invocation.agentId ?? '<none>'} — prompt copied to clipboard, user pastes manually`,
    );
    void vscode.window.showWarningMessage(Messages.PromptCopiedToClipboard);
    return {
      delivered: false,
      message: 'Prompt copied to clipboard — paste it into the agent manually',
      extra: { sent: false, fallback: 'clipboard' },
    };
  }

  stop(): void {
    // No-op — clipboard write is synchronous, nothing to cancel.
  }
}

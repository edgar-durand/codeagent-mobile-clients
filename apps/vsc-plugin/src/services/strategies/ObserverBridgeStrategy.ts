import * as vscode from 'vscode';
import type { OutputChannel } from 'vscode';
import type { AgentInvocation, AgentStrategy, StrategyResult } from './AgentStrategy';
import { AgentOutputMonitor } from '../agent-output-monitor';
import { Messages } from '../../ui/messages';

/**
 * Catch-all strategy for any agent that doesn't match a more
 * specific one. Equivalent to the JetBrains `GenericFallbackStrategy`,
 * but uses VS Code's transport stack instead of JCEF — VS Code is
 * built on Electron's renderer, not Chromium-embedded, so we hand
 * the prompt to AgentOutputMonitor's pending-prompt queue, which the
 * same-origin observer script picks up and injects into the
 * Lexical-based chat editor.
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
    const monitor = AgentOutputMonitor.getInstance();
    let delivered = false;
    let message = 'Prompt copied to clipboard';

    try {
      monitor.queuePrompt(invocation.prompt);
      this.log.appendLine(`[${this.name}] queued via observer bridge`);
      delivered = true;
      message = 'Prompt sent to AI agent';
    } catch (e) {
      this.log.appendLine(`[${this.name}] observer bridge failed: ${e}`);
      await vscode.env.clipboard.writeText(invocation.prompt);
      vscode.window.showWarningMessage(Messages.PromptCopiedToClipboard);
    }

    if (delivered) {
      monitor.startMonitoring(invocation.sessionId, invocation.prompt);
    }

    return { delivered, message, extra: { sent: delivered } };
  }

  stop(): void {
    AgentOutputMonitor.getInstance().stopMonitoring();
  }
}

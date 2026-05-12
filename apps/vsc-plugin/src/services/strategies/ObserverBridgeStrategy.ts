import * as vscode from 'vscode';
import type { OutputChannel } from 'vscode';
import type { AgentInvocation, AgentStrategy, StrategyResult } from './AgentStrategy';
import { AgentOutputMonitor } from '../agent-output-monitor';

/**
 * Catch-all strategy for any agent that doesn't match a more
 * specific one. Equivalent to the JetBrains `GenericFallbackStrategy`,
 * but uses VS Code's transport stack instead of JCEF — VS Code is
 * built on Electron's renderer, not Chromium-embedded, so we hit
 * the per-IDE observer helper at `localhost:47832` that injects
 * into Lexical-based chat editors. If that helper isn't running or
 * fails, we degrade to "copy to clipboard + nudge the user".
 *
 * Always returns true from `canHandle`, so it MUST be registered
 * last in the registry.
 */
export class ObserverBridgeStrategy implements AgentStrategy {
  readonly name = 'ObserverBridgeStrategy';

  private static readonly BRIDGE_PORT = 47832;

  constructor(private readonly log: OutputChannel) {}

  canHandle(_invocation: AgentInvocation): boolean {
    return true;
  }

  async execute(invocation: AgentInvocation): Promise<StrategyResult> {
    let delivered = false;
    let message = 'Prompt copied to clipboard';

    try {
      await this.httpPost(
        `http://127.0.0.1:${ObserverBridgeStrategy.BRIDGE_PORT}/submit`,
        invocation.prompt,
      );
      this.log.appendLine(`[${this.name}] submitted via observer bridge`);
      delivered = true;
      message = 'Prompt sent to AI agent';
    } catch (e) {
      this.log.appendLine(`[${this.name}] observer bridge failed: ${e}`);
      await vscode.env.clipboard.writeText(invocation.prompt);
      vscode.window.showWarningMessage(
        'CodeAgent: Prompt copied to clipboard. Please paste into the AI chat and press Enter.',
      );
    }

    if (delivered) {
      AgentOutputMonitor.getInstance().startMonitoring(invocation.sessionId, invocation.prompt);
    }

    return { delivered, message, extra: { sent: delivered } };
  }

  stop(): void {
    AgentOutputMonitor.getInstance().stopMonitoring();
  }

  private httpPost(url: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const http = require('http') as typeof import('http');
      const parsed = new URL(url);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => resolve(data));
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

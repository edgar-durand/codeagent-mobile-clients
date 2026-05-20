import type { OutputChannel } from 'vscode';
import type { AgentInvocation, AgentStrategy, StrategyResult } from './AgentStrategy';
import { TerminalClaudeCodeStrategy } from './TerminalClaudeCodeStrategy';
import { CopilotLmStrategy } from './CopilotLmStrategy';
import { ObserverBridgeStrategy } from './ObserverBridgeStrategy';

/**
 * Registry + dispatch for `AgentStrategy` implementations. Mirrors
 * the JetBrains plugin's `AgentStrategyRegistry` so both clients
 * route remote commands the same way.
 *
 * Resolution order matters: the registry walks `strategies` in
 * declaration order and returns the first whose `canHandle`
 * returns true. The `ObserverBridgeStrategy` MUST stay last
 * because it returns true unconditionally.
 *
 * `lastActive` is tracked so `stop()` can tear down the strategy
 * that actually started monitoring on the previous turn, instead
 * of broadcasting `stopMonitoring()` to every service.
 *
 * `lastAgentActivityTs` is the Unix-ms timestamp of the most recent
 * `execute()` dispatch. The file watcher reads it to gate event
 * emission: only files saved within `AGENT_ACTIVITY_WINDOW_MS` of an
 * agent turn count as "agent-driven" (Path B has no PTY tool-use
 * stream to derive this from, so an activity window is the cheapest
 * heuristic that works). A value of `0` means no agent has ever run
 * in this VS Code session.
 */
export class AgentStrategyRegistry {
  private static instance: AgentStrategyRegistry | null = null;

  private readonly strategies: readonly AgentStrategy[];
  private lastActive: AgentStrategy | null = null;
  private _lastAgentActivityTs = 0;

  private constructor(private readonly log: OutputChannel) {
    this.strategies = [
      new TerminalClaudeCodeStrategy(log),
      new CopilotLmStrategy(log),
      // Catch-all — keep last.
      new ObserverBridgeStrategy(log),
    ];
  }

  static getInstance(log: OutputChannel): AgentStrategyRegistry {
    if (!AgentStrategyRegistry.instance) {
      AgentStrategyRegistry.instance = new AgentStrategyRegistry(log);
    }
    return AgentStrategyRegistry.instance;
  }

  /**
   * Pick the first strategy whose `canHandle` matches, then `execute`
   * it. Records the strategy as `lastActive` so `stop()` can tear it
   * down later. Returns the strategy's `StrategyResult` verbatim.
   */
  async execute(invocation: AgentInvocation): Promise<StrategyResult> {
    const strategy = this.strategies.find((s) => s.canHandle(invocation));
    if (!strategy) {
      // This shouldn't happen — `ObserverBridgeStrategy` is the
      // catch-all and always matches. If it does, log loudly and
      // return a sentinel so the caller still pushes a result.
      this.log.appendLine(
        `[AgentStrategyRegistry] no strategy matched (agentId=${invocation.agentId ?? '<none>'}) — registry mis-ordered?`,
      );
      return { delivered: false, message: 'No matching agent strategy' };
    }
    this.log.appendLine(
      `[AgentStrategyRegistry] dispatching to ${strategy.name} (agentId=${invocation.agentId ?? '<auto>'})`,
    );
    this.lastActive = strategy;
    this._lastAgentActivityTs = Date.now();
    return strategy.execute(invocation);
  }

  /**
   * Unix-ms timestamp of the most recent `execute()` dispatch, or `0`
   * if no agent has run yet in this session. Read by the file watcher
   * to gate event emission to "recently agent-active" windows.
   */
  get lastAgentActivityTs(): number {
    return this._lastAgentActivityTs;
  }

  /**
   * Test seam — lets unit tests pin a synthetic activity timestamp
   * without first dispatching a real strategy. Not exported via the
   * public surface; production code only ever reads the getter.
   */
  /* @internal */ _setLastAgentActivityTsForTest(ts: number): void {
    this._lastAgentActivityTs = ts;
  }

  /**
   * Tear down whatever the last-executed strategy started. Safe to
   * call when nothing is active. Does NOT touch strategies other
   * than `lastActive` — the panel keeps its own broad cleanup
   * (`AgentBridgeService.cancelCurrentTask`, etc.) for the cases
   * where the user wants to nuke everything regardless of which
   * strategy was active.
   */
  stop(): void {
    if (!this.lastActive) return;
    this.log.appendLine(`[AgentStrategyRegistry] stopping ${this.lastActive.name}`);
    try {
      this.lastActive.stop();
    } catch (e) {
      this.log.appendLine(`[AgentStrategyRegistry] ${this.lastActive.name}.stop() threw: ${e}`);
    }
    this.lastActive = null;
  }
}

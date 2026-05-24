import type { DetectedAgent } from '../ide-integration.service';

/**
 * Per-agent strategy pattern, mirroring the JetBrains plugin's
 * `AgentStrategy` interface so both clients dispatch the same way.
 * The lockstep contract:
 *
 *   - `AgentInvocation` carries the same logical fields on both sides
 *     (agentId, commandId, prompt, sessionId, optional model). JB
 *     also carries a `project`; VS Code's extension host has no
 *     equivalent, so that field stays JB-only.
 *   - `execute` returns a `StrategyResult` (delivered / message /
 *     extra) — same shape on both sides so the relay payload is
 *     byte-compatible regardless of which IDE is paired.
 *   - `stop` tears down whatever monitoring this strategy started.
 *
 * Cross-reference: apps/jetbrains-plugin/.../strategies/AgentStrategy.kt
 *
 * The panel layer (`ControllerPanelProvider`) stays generic — it
 * builds an `AgentInvocation` from the incoming remote command and
 * hands it to `AgentStrategyRegistry`. Per-agent code lives in
 * concrete strategy files, not in a giant switch.
 */
export interface AgentInvocation {
  /** Resolved DetectedAgent. May be undefined if `agentId` was unknown. */
  agent: DetectedAgent | undefined;
  /** Raw agent id from the remote command payload. */
  agentId: string | undefined;
  /** Prompt text the user typed, after attachment expansion. */
  prompt: string;
  /** Paired session id — used to scope output monitoring + relay results. */
  sessionId: string;
  /** Command id — used by the strategy to push a result back. */
  commandId: string;
  /** Optional model override from the mobile picker. */
  model?: string;
}

export interface StrategyResult {
  /** True if the prompt was delivered (or accepted and now streaming). */
  delivered: boolean;
  /** Human-facing message for the relay result. */
  message: string;
  /**
   * Extra fields merged into the relay result payload — e.g. Copilot
   * adds `{ sent: boolean }`. Optional; defaults to empty.
   */
  extra?: Record<string, unknown>;
}

export interface AgentStrategy {
  /** Identifying name for log output. */
  readonly name: string;
  /**
   * First strategy to return true wins. Order matters — register
   * the most specific strategies first, with the catch-all
   * fallback last.
   */
  canHandle(invocation: AgentInvocation): boolean;
  /**
   * Deliver the prompt + start whatever monitoring is appropriate
   * for this agent. Returns a `StrategyResult` so the registry can
   * forward it as a relay result without leaking strategy-internal
   * details.
   */
  execute(invocation: AgentInvocation): Promise<StrategyResult>;
  /** Tear down any monitoring this strategy started. Idempotent. */
  stop(): void;
}

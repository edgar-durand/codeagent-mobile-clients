import { AGENT_REGISTRY, type AgentId } from '@codeam/shared';
import { createOsStrategy, type OsStrategy } from '../os';
import { ClaudeRuntimeStrategy } from './claude/runtime';
import { ClaudeDeployStrategy } from './claude/deploy';
import { CodexRuntimeStrategy } from './codex/runtime';
import { CodexDeployStrategy } from './codex/deploy';
import { CoderabbitRuntimeStrategy } from './coderabbit/runtime';
import { CursorRuntimeStrategy } from './cursor/runtime';
import { AiderRuntimeStrategy } from './aider/runtime';
import { GeminiRuntimeStrategy } from './gemini/runtime';
import type { AgentStrategy, RuntimeStrategy, DeployStrategy } from './strategy';

/**
 * Per-agent runtime (PTY/REPL) strategy builders.
 *
 * claude / codex / gemini are dispatched ACP-only at runtime (see
 * `requiresAcp` in `acp/adapters.ts` + the dispatch in `start.ts`) —
 * the legacy PTY-spawn path is never taken for them. Their builders
 * survive anyway because the ACP runner (`listModels`, headless
 * `generateOneShot`, legacy file/preview handlers), `codeam link`
 * (`credentialLocator` / `loginLauncher`), and `HistoryService`
 * (transcript parsing) still resolve the strategy via
 * `createInteractiveAgentStrategy`. Their TUI-parsing methods are
 * inert stubs now that the React-Ink / ratatui parsers are gone.
 *
 * aider / cursor / coderabbit have no ACP adapter and DO spawn over
 * the PTY runtime built here.
 */
const runtimeBuilders: Partial<Record<AgentId, (os: OsStrategy) => AgentStrategy>> = {
  claude: (os) => new ClaudeRuntimeStrategy(os),
  codex: (os) => new CodexRuntimeStrategy(os),
  coderabbit: (os) => new CoderabbitRuntimeStrategy(os),
  cursor: (os) => new CursorRuntimeStrategy(os),
  aider: (os) => new AiderRuntimeStrategy(os),
  gemini: (os) => new GeminiRuntimeStrategy(os),
};

const deployBuilders: Partial<Record<AgentId, () => DeployStrategy>> = {
  claude: () => new ClaudeDeployStrategy(),
  codex: () => new CodexDeployStrategy(),
};

/**
 * Resolve the per-agent strategy of any shape (Interactive REPL or
 * Batch one-shot). Composes an OsStrategy into every agent so
 * per-platform behaviour (PATH probes, .cmd / .ps1 wrapping, signal
 * capabilities) is handled uniformly without each agent
 * reimplementing the `process.platform` ladder.
 *
 * `os` argument is for tests — production callers should let it
 * default to `createOsStrategy()` (the memoised host strategy).
 */
export function createAgentStrategy(
  agent: AgentId,
  os: OsStrategy = createOsStrategy(),
): AgentStrategy {
  if (!AGENT_REGISTRY[agent]?.enabled) {
    throw new Error(
      `Agent "${agent}" is not supported in this codeam-cli version. Upgrade with 'npm i -g codeam-cli@latest'.`,
    );
  }
  const build = runtimeBuilders[agent];
  if (!build) {
    throw new Error(`No runtime strategy registered for agent "${agent}"`);
  }
  return build(os);
}

/**
 * Resolve an INTERACTIVE-only agent strategy. Throws when the
 * requested agent is batch-mode — those don't have a PTY surface
 * and can't be passed to `AgentService.spawn()`. Used by `start.ts`
 * which always launches a long-lived REPL.
 */
export function createInteractiveAgentStrategy(
  agent: AgentId,
  os: OsStrategy = createOsStrategy(),
): RuntimeStrategy {
  const s = createAgentStrategy(agent, os);
  if (s.mode !== 'interactive') {
    throw new Error(
      `Agent "${agent}" is a batch agent; use createAgentStrategy + .runOneShot for one-shot reviews.`,
    );
  }
  return s;
}

/**
 * Backward-compat alias used pervasively across the codebase. Pre-#58,
 * `createRuntimeStrategy` returned an Interactive (the only kind).
 * Kept exported with the same name + Interactive-only return type so
 * existing `start.ts` / `link.ts` callers compile unchanged.
 */
export const createRuntimeStrategy = createInteractiveAgentStrategy;

/**
 * Test-only: enumerate every registered agent id (ignoring the
 * `enabled` gate). The contract suite (#62) iterates over this to
 * assert EVERY agent we ship a strategy for satisfies the interface
 * contract — including agents currently gated behind a feature flag.
 * Without this surface, the contract would only run against the
 * handful of agents currently enabled, and a gated agent could
 * silently rot until its flag flipped.
 *
 * Production code uses `createAgentStrategy` (gated) — never this.
 */
export function listRegisteredAgentIdsForTests(): AgentId[] {
  return Object.keys(runtimeBuilders) as AgentId[];
}

/**
 * Test-only: instantiate a registered agent strategy bypassing the
 * `AGENT_REGISTRY.enabled` gate. Used by the contract suite to
 * validate gated agents.
 */
export function createAgentStrategyForTests(
  agent: AgentId,
  os: OsStrategy = createOsStrategy(),
): AgentStrategy {
  const build = runtimeBuilders[agent];
  if (!build) {
    throw new Error(`No runtime strategy registered for agent "${agent}"`);
  }
  return build(os);
}

export function createDeployStrategy(agent: AgentId): DeployStrategy {
  if (!AGENT_REGISTRY[agent]?.enabled) {
    throw new Error(`Agent "${agent}" is not supported in this codeam-cli version.`);
  }
  const build = deployBuilders[agent];
  if (!build) {
    throw new Error(`No deploy strategy registered for agent "${agent}"`);
  }
  return build();
}

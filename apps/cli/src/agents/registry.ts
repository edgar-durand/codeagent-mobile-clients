import { AGENT_REGISTRY, type AgentId } from '@codeagent/shared';
import { createOsStrategy, type OsStrategy } from '../os';
import { ClaudeRuntimeStrategy } from './claude/runtime';
import { ClaudeDeployStrategy } from './claude/deploy';
import { CodexRuntimeStrategy } from './codex/runtime';
import { CodexDeployStrategy } from './codex/deploy';
import { CoderabbitRuntimeStrategy } from './coderabbit/runtime';
import { CursorRuntimeStrategy } from './cursor/runtime';
import { AiderRuntimeStrategy } from './aider/runtime';
import type { AgentStrategy, RuntimeStrategy, DeployStrategy } from './strategy';

const runtimeBuilders: Partial<Record<AgentId, (os: OsStrategy) => AgentStrategy>> = {
  claude: (os) => new ClaudeRuntimeStrategy(os),
  codex: (os) => new CodexRuntimeStrategy(os),
  coderabbit: (os) => new CoderabbitRuntimeStrategy(os),
  cursor: (os) => new CursorRuntimeStrategy(os),
  aider: (os) => new AiderRuntimeStrategy(os),
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

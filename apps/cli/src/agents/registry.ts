import { AGENT_REGISTRY, type AgentId } from '@codeagent/shared';
import { createOsStrategy, type OsStrategy } from '../os';
import { ClaudeRuntimeStrategy } from './claude/runtime';
import { ClaudeDeployStrategy } from './claude/deploy';
import { CodexRuntimeStrategy } from './codex/runtime';
import { CodexDeployStrategy } from './codex/deploy';
import type { RuntimeStrategy, DeployStrategy } from './strategy';

const runtimeBuilders: Partial<Record<AgentId, (os: OsStrategy) => RuntimeStrategy>> = {
  claude: (os) => new ClaudeRuntimeStrategy(os),
  codex: (os) => new CodexRuntimeStrategy(os),
};

const deployBuilders: Partial<Record<AgentId, () => DeployStrategy>> = {
  claude: () => new ClaudeDeployStrategy(),
  codex: () => new CodexDeployStrategy(),
};

/**
 * Resolve the per-agent runtime strategy. Composes an OsStrategy
 * into every agent so per-platform behaviour (PATH probes, .cmd /
 * .ps1 wrapping, signal capabilities) is handled uniformly without
 * each agent reimplementing the `process.platform` ladder.
 *
 * `os` argument is for tests — production callers should let it
 * default to `createOsStrategy()` (the memoised host strategy).
 */
export function createRuntimeStrategy(
  agent: AgentId,
  os: OsStrategy = createOsStrategy(),
): RuntimeStrategy {
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

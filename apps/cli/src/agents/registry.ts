import { AGENT_REGISTRY, type AgentId } from '@codeagent/shared';
import { ClaudeRuntimeStrategy } from './claude/runtime';
import { ClaudeDeployStrategy } from './claude/deploy';
import type { RuntimeStrategy, DeployStrategy } from './strategy';

const runtimeBuilders: Partial<Record<AgentId, () => RuntimeStrategy>> = {
  claude: () => new ClaudeRuntimeStrategy(),
  // codex and copilot added in Phase 2 / later
};

const deployBuilders: Partial<Record<AgentId, () => DeployStrategy>> = {
  claude: () => new ClaudeDeployStrategy(),
};

export function createRuntimeStrategy(agent: AgentId): RuntimeStrategy {
  if (!AGENT_REGISTRY[agent]?.enabled) {
    throw new Error(
      `Agent "${agent}" is not supported in this codeam-cli version. Upgrade with 'npm i -g codeam-cli@latest'.`,
    );
  }
  const build = runtimeBuilders[agent];
  if (!build) {
    throw new Error(`No runtime strategy registered for agent "${agent}"`);
  }
  return build();
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

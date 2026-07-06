import { AGENT_REGISTRY, normalizeAgentId, type AgentId } from '@codeam/shared';

/**
 * Normalize whatever agent id the wire delivered (registry id, public
 * `claude_code` form, marketplace extension id, `__terminal__:`-prefixed
 * plugin id) onto a CLI-launchable {@link AgentId}.
 *
 * Thin wrapper over the shared `normalizeAgentId` (`@codeam/shared`
 * `agents/identity.ts` — the ONE alias normalizer): this layer only adds
 * the non-string guard and the plugin's availability gate (a known but
 * DISABLED agent, e.g. copilot today, is not launchable → null).
 */
export function normalizeCliAgentId(raw: unknown): AgentId | null {
  if (typeof raw !== 'string') return null;
  const id = normalizeAgentId(raw);
  if (!id || !AGENT_REGISTRY[id].enabled) return null;
  return id;
}

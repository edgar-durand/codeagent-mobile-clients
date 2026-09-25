import * as p from '@clack/prompts';
import { AGENT_REGISTRY, getEnabledAgents, isKnownAgentId, type AgentId } from '@codeam/shared';

/**
 * Parse `--agent=<id>` OR `--agent <id>` from CLI args. Returns `null` when the
 * flag is absent. Throws if the flag is present but the value is missing,
 * unknown or disabled in this version.
 *
 * ⚠️ The help text has always advertised the SPACE form (`codeam pair --agent
 * <id>`), but only `--agent=<id>` was parsed — the documented form was ignored
 * silently and the "non-interactive" pair fell into the interactive picker,
 * which hangs a script (break-it session 2026-09-24).
 */
export function parseAgentFlag(args: string[]): AgentId | null {
  let value: string | undefined;
  const eq = args.find((a) => a.startsWith('--agent='));
  if (eq) {
    value = eq.slice('--agent='.length);
  } else {
    const i = args.indexOf('--agent');
    if (i === -1) return null;
    value = args[i + 1];
    if (!value || value.startsWith('-')) {
      throw new Error(`--agent needs a value; valid: ${Object.keys(AGENT_REGISTRY).join(', ')}`);
    }
  }
  if (!isKnownAgentId(value)) {
    throw new Error(
      `invalid agent "${value}"; valid: ${Object.keys(AGENT_REGISTRY).join(', ')}`,
    );
  }
  if (!AGENT_REGISTRY[value].enabled) {
    throw new Error(
      `${AGENT_REGISTRY[value].displayName} is not available in this codeam-cli version`,
    );
  }
  return value;
}

/**
 * Interactive picker. If only one agent is enabled (Phase 1: Claude), skips the prompt.
 * Otherwise prompts via @clack/prompts with the initialValue preselected.
 */
export async function promptForAgent(initialValue?: AgentId): Promise<AgentId> {
  const enabled = getEnabledAgents();
  if (enabled.length === 1) {
    return enabled[0].id;
  }
  const chosen = await p.select<AgentId>({
    message: 'Pick an agent:',
    options: enabled.map((m) => ({ value: m.id, label: m.displayName })),
    initialValue: initialValue ?? enabled[0].id,
  });
  if (p.isCancel(chosen)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  return chosen as AgentId;
}

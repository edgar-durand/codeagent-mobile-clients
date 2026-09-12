import { describe, it, expect } from 'vitest';
import {
  HOUSE_AGENT_ID,
  LINKED_AGENT_IDS,
  MANAGED_AGENT_ENV,
  MANAGED_PROVIDER_DISPLAY_NAMES,
  MANAGED_PROVIDER_IDS,
  PUBLIC_TO_INTERNAL,
  isLinkedAgentId,
  isManagedProviderId,
} from '../src/agents/identity';

/**
 * Managed providers (Managed Agents + Credits, 2026-09-11) are public agent
 * ids across every surface: a LinkedAgent row, an install target, a switch
 * target. They run the Claude Code runtime against our proxy — same as the
 * house agent — so the id bridge must say `claude` for all of them.
 */
describe('managed provider ids', () => {
  it('are public LinkedAgentIds', () => {
    for (const id of MANAGED_PROVIDER_IDS) {
      expect(isLinkedAgentId(id)).toBe(true);
      expect(LINKED_AGENT_IDS).toContain(id);
      expect(isManagedProviderId(id)).toBe(true);
    }
    expect(isManagedProviderId(HOUSE_AGENT_ID)).toBe(false);
    expect(isManagedProviderId('claude_code')).toBe(false);
    expect(isManagedProviderId(undefined)).toBe(false);
  });

  it('all run the claude runtime (house rail)', () => {
    for (const id of MANAGED_PROVIDER_IDS) expect(PUBLIC_TO_INTERNAL[id]).toBe('claude');
  });

  it('every managed id has a user-facing name that names the model, not the upstream vendor', () => {
    for (const id of MANAGED_PROVIDER_IDS) {
      const name = MANAGED_PROVIDER_DISPLAY_NAMES[id];
      expect(name.length).toBeGreaterThan(0);
      expect(name).not.toMatch(/deepinfra|openai|anthropic/i);
    }
  });

  it('exports the env var the bootstrap uses to tell the CLI which managed agent runs', () => {
    expect(MANAGED_AGENT_ENV).toBe('CODEAM_MANAGED_AGENT_ID');
  });
});

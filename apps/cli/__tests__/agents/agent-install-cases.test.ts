/**
 * Coverage contract for the real per-agent install gate.
 *
 * Runs in the NORMAL unit suite — no Docker, no network, no env gate. That is
 * the whole point: the gate itself only runs under `RUN_AGENT_INSTALL_INT=1`,
 * so if this assertion lived inside it, someone could add an agent to
 * `INSTALL_SNIPPETS` and no PR check would notice that the new agent's install
 * is never exercised.
 */
import { describe, it, expect } from 'vitest';
import { INSTALL_SNIPPETS, type AgentId } from '@codeam/shared';
import { AGENT_INSTALL_CASES } from '../fixtures/agent-install-cases';

describe('agent-install case table', () => {
  it('records a decision for every agent in INSTALL_SNIPPETS', () => {
    for (const id of Object.keys(INSTALL_SNIPPETS)) {
      expect(
        AGENT_INSTALL_CASES[id],
        `no agent-install case recorded for "${id}" — add a real case or a tracked skip in __tests__/fixtures/agent-install-cases.ts`,
      ).toBeDefined();
    }
  });

  it('has no case for an agent that is not in INSTALL_SNIPPETS', () => {
    for (const id of Object.keys(AGENT_INSTALL_CASES)) {
      expect(
        INSTALL_SNIPPETS[id as AgentId],
        `case "${id}" is not in INSTALL_SNIPPETS`,
      ).toBeDefined();
    }
  });

  it('every tracked skip carries a substantive reason', () => {
    for (const [id, c] of Object.entries(AGENT_INSTALL_CASES)) {
      if (c.kind !== 'tracked-skip') continue;
      expect(c.reason.length, `tracked skip for ${id} has no real reason`).toBeGreaterThan(20);
    }
  });

  it('every real case carries a note explaining what makes it interesting', () => {
    for (const [id, c] of Object.entries(AGENT_INSTALL_CASES)) {
      if (c.kind !== 'real') continue;
      expect(c.note.length, `real case for ${id} has no note`).toBeGreaterThan(10);
    }
  });
});

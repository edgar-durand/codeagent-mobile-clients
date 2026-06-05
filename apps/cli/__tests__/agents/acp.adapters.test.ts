/**
 * Smoke tests for the ACP adapter registry — every entry must
 * resolve to an absolute file path AND advertise the underlying
 * agent binary so we surface helpful errors when the user hasn't
 * installed it.
 */

import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getAcpAdapter, listAcpAdapterIdsForTests } from '../../src/agents/acp/adapters';

describe('ACP adapter registry', () => {
  it.each(listAcpAdapterIdsForTests())(
    'resolves a real bin path + requires a binary for %s',
    (agentId) => {
      const spec = getAcpAdapter(agentId);
      expect(spec, `missing adapter spec for ${agentId}`).not.toBeNull();
      expect(spec!.command).toBeTruthy();
      expect(spec!.args.length).toBeGreaterThan(0);
      // First arg is the resolved bin script — must exist on disk
      // (the npm install in CI guarantees node_modules is present).
      expect(fs.existsSync(spec!.args[0]), `bin not found at ${spec!.args[0]}`).toBe(true);
      expect(spec!.requiresAgentBinary).toMatch(/^[a-z][a-z0-9-]+$/);
    },
  );

  it('returns null for an agent without an ACP adapter', () => {
    // `aider` is a registered agent but has no ACP adapter — used
    // here as a deliberate negative case so a future addition of
    // an aider adapter doesn't silently break this assumption.
    expect(getAcpAdapter('aider')).toBeNull();
  });
});

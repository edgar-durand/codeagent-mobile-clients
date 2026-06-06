/**
 * Smoke tests for the ACP adapter registry — every entry must
 * advertise the underlying agent binary, and (for npm-adapter
 * specs) resolve `args[0]` to an actual bin file under
 * `node_modules`. Native-ACP specs (e.g. `gemini --acp`) are
 * resolved from PATH at spawn time and skip the on-disk check.
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
      // npm-adapter shape: `command === process.execPath` and
      // `args[0]` is an absolute path to a bin script inside
      // node_modules. Native-ACP shape: `command` is the agent
      // binary name (PATH-resolved at runtime) and `args` are flags.
      const isNpmAdapter = spec!.command === process.execPath;
      if (isNpmAdapter) {
        expect(fs.existsSync(spec!.args[0]), `bin not found at ${spec!.args[0]}`).toBe(true);
      } else {
        expect(spec!.command).toMatch(/^[a-z][a-z0-9-]+$/);
      }
      expect(spec!.requiresAgentBinary).toMatch(/^[a-z][a-z0-9-]+$/);
    },
  );

  it('returns null for an agent without an ACP adapter', () => {
    // `aider` is a registered agent but has no ACP adapter — used
    // here as a deliberate negative case so a future addition of
    // an aider adapter doesn't silently break this assumption.
    expect(getAcpAdapter('aider')).toBeNull();
  });

  it('returns null for cursor until upstream adapter migrates off the deprecated SDK', () => {
    // cursor-agent-acp@0.1.1 still depends on the deprecated
    // @zed-industries/agent-client-protocol; we dropped the bundle
    // entry in v2.27.5 to keep `npm i -g codeam-cli` clean. Re-add
    // the entry + delete this test when @agentclientprotocol/cursor-acp
    // ships (or upstream publishes a non-deprecated version).
    expect(getAcpAdapter('cursor')).toBeNull();
  });
});

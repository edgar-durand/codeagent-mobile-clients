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

  // Regression guard for the 2026-07-03 codespace incident, generalized
  // to ALL agents: every ACP adapter MUST expose a `waitForBinary` so the
  // agent-spawn gate can wait for its launch binary to finish installing
  // (claude's SDK native binary, `npm i -g @openai/codex`, cursor/gemini
  // installers) instead of spawning too early and dying "binary not
  // found". A new adapter that forgets this fails here.
  it.each(listAcpAdapterIdsForTests())('exposes a waitForBinary readiness check for %s', (agentId) => {
    const spec = getAcpAdapter(agentId);
    expect(spec, `missing adapter spec for ${agentId}`).not.toBeNull();
    expect(typeof spec!.waitForBinary, `${agentId} must declare waitForBinary`).toBe('function');
  });

  it('waitForBinary resolves quickly for a PATH agent already installed (cursor)', async () => {
    const spec = getAcpAdapter('cursor');
    // A 0 ms timeout means: check once, don't block. Returns a boolean
    // either way (true if cursor-agent happens to be on PATH here, false
    // otherwise) — the point is it's callable and non-throwing.
    await expect(spec!.waitForBinary({ timeoutMs: 0 })).resolves.toBeTypeOf('boolean');
  });

  it('returns null for an agent without an ACP adapter', () => {
    // `aider` is a registered agent but has no ACP adapter — used
    // here as a deliberate negative case so a future addition of
    // an aider adapter doesn't silently break this assumption.
    expect(getAcpAdapter('aider')).toBeNull();
  });

  it('resolves cursor via the NATIVE `cursor-agent acp` adapter (no npm package)', () => {
    // cursor-agent ships a built-in ACP server (`cursor-agent acp`), so we use
    // the native binary directly (like `gemini --acp`) — NOT the deprecated
    // cursor-agent-acp npm package. Routing cursor over ACP (not the legacy
    // PTY) is what delivers CURSOR_API_KEY to it via the ACP client's env.
    const spec = getAcpAdapter('cursor');
    expect(spec).not.toBeNull();
    expect(spec!.command).toBe('cursor-agent');
    expect(spec!.args).toEqual(['acp']);
    expect(spec!.requiresAgentBinary).toBe('cursor-agent');
  });
});

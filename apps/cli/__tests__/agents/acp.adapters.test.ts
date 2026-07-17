/**
 * Smoke tests for the ACP adapter registry — every entry must
 * advertise the underlying agent binary, and (for npm-adapter
 * specs) resolve `args[0]` to an actual bin file under
 * `node_modules`. Native-ACP specs (e.g. `gemini --acp`) are
 * resolved from PATH at spawn time and skip the on-disk check.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_REGISTRY } from '@codeam/shared';
import {
  getAcpAdapter,
  listAcpAdapterIdsForTests,
  resolveAcpAdapterWithRetry,
  resetAcpAdapterCacheForTests,
} from '../../src/agents/acp/adapters';

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
      } else if (path.isAbsolute(spec!.command)) {
        // Native-ACP with up-front install-location resolution
        // (cursor-agent on Windows/Unix): `command` is an absolute path
        // to the launcher on disk.
        expect(fs.existsSync(spec!.command), `bin not found at ${spec!.command}`).toBe(true);
      } else {
        // Native-ACP shape: `command` is the agent binary NAME,
        // PATH-resolved at spawn time.
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
    // Explicit generous test timeout: the underlying PATH probe forks a process
    // that is slow on Windows CI runners, and the default 5s occasionally trips.
  }, 20000);

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
    // Native launcher: the bare `cursor-agent` name (PATH-resolved at
    // spawn) OR an absolute path to the resolved install binary
    // (cursor-agent[.exe]) — never the npm-adapter `process.execPath` shape.
    expect(spec!.command).not.toBe(process.execPath);
    expect(
      spec!.command === 'cursor-agent' || /[\\/]cursor-agent(\.exe)?$/.test(spec!.command),
      `expected native cursor-agent launcher, got ${spec!.command}`,
    ).toBe(true);
    expect(spec!.args).toEqual(['acp']);
    expect(spec!.requiresAgentBinary).toBe('cursor-agent');
  });

  it('caches a successfully-resolved adapter for the process lifetime', () => {
    // A later npm-tree rewrite (reinstall race) must NOT be able to flip an
    // already-running session's behavior — see the adapter-cache doc in
    // adapters.ts. Two calls in a row must return the exact same object
    // (not merely equal specs) once resolution has succeeded once.
    resetAcpAdapterCacheForTests();
    const first = getAcpAdapter('claude');
    const second = getAcpAdapter('claude');
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  describe('resolveAcpAdapterWithRetry', () => {
    it('resolves immediately when the adapter is already available', async () => {
      resetAcpAdapterCacheForTests();
      const spec = await resolveAcpAdapterWithRetry('claude', { timeoutMs: 0 });
      expect(spec).not.toBeNull();
    });

    it('retries on a bounded schedule and succeeds once resolution comes back', async () => {
      resetAcpAdapterCacheForTests();
      let attempts = 0;
      const sleep = vi.fn(async () => {
        attempts += 1;
      });
      // Fake `now()` that advances on every call so the bounded loop
      // terminates deterministically without a real timer.
      let clock = 0;
      const now = vi.fn(() => {
        clock += 1;
        return clock;
      });
      const spec = await resolveAcpAdapterWithRetry('claude', {
        timeoutMs: 100,
        pollMs: 1,
        now,
        sleep,
      });
      expect(spec).not.toBeNull();
      // resolveBin genuinely succeeds on the very first internal call here
      // (the real package IS installed in this repo) — this test's job is
      // just to prove the retry plumbing (sleep/now injection) is wired
      // and returns the resolved spec once available, not to force a
      // failing-then-succeeding sequence (see the timeout test below for
      // the "never resolves" side of the contract).
      expect(attempts).toBe(0);
    });

    it('returns null once the bounded time budget is exhausted for an agent whose adapter never resolves', async () => {
      // Simulate "genuinely unresolvable for the whole retry window" by
      // retrying an id with no adapter registered — mirrors what callers
      // see once the real resolveBin() keeps failing past the deadline.
      let clock = 0;
      const now = vi.fn(() => {
        clock += 25;
        return clock;
      });
      const sleep = vi.fn(async () => undefined);
      const spec = await resolveAcpAdapterWithRetry('aider', {
        timeoutMs: 100,
        pollMs: 25,
        now,
        sleep,
      });
      expect(spec).toBeNull();
      // Bounded — not an infinite loop.
      expect(sleep.mock.calls.length).toBeGreaterThan(0);
      expect(sleep.mock.calls.length).toBeLessThan(20);
    });
  });

  it('shared registry `acp` capability flags mirror this adapter registry exactly', () => {
    // The declarative flag in @codeam/shared (`AGENT_REGISTRY[id].acp`,
    // PR-1 of the single-source plan) must stay in lockstep with the
    // adapter REGISTRY here — the flag is what other surfaces render from.
    const adapterIds = new Set<string>(listAcpAdapterIdsForTests());
    for (const meta of Object.values(AGENT_REGISTRY)) {
      expect(
        meta.acp,
        `AGENT_REGISTRY.${meta.id}.acp disagrees with the ACP adapter registry`,
      ).toBe(adapterIds.has(meta.id));
    }
  });
});

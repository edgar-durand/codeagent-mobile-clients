import { describe, it, expect, afterEach } from 'vitest';
import Module from 'node:module';
import {
  requiresAcp,
  getAcpAdapter,
  resetAcpAdapterCacheForTests,
} from '../../src/agents/acp/adapters';

type ResolveFilename = (...args: unknown[]) => string;

/**
 * Dispatch invariant for the ACP-only cutover (start.ts).
 *
 * `requiresAcp(agent)` is the single source of truth for the launch
 * decision: when true, ACP is the agent's ONLY path (no env flag, no
 * PTY fallback). These tests pin that contract so a regression that
 * re-introduces a PTY fallback for claude/codex — or an escape-hatch
 * env flag — fails here instead of in production.
 */
describe('start dispatch — ACP launch mode', () => {
  afterEach(() => {
    delete process.env.CODEAM_ACP_DISABLED;
    delete process.env.CODEAM_ACP_ENABLED;
  });

  it('claude and codex always resolve an ACP adapter (ACP branch)', () => {
    expect(requiresAcp('claude')).toBe(true);
    expect(requiresAcp('codex')).toBe(true);
    expect(getAcpAdapter('claude')).not.toBeNull();
    expect(getAcpAdapter('codex')).not.toBeNull();
  });

  it('gemini requires ACP (native --acp adapter)', () => {
    expect(requiresAcp('gemini')).toBe(true);
  });

  it('cursor requires ACP (native `cursor-agent acp` adapter)', () => {
    // cursor-agent ships a built-in ACP server; routing it over ACP (not the
    // legacy PTY) is what lets the provisioned CURSOR_API_KEY reach it via the
    // ACP client's `env: { ...process.env, ...extraEnv }` spawn.
    expect(requiresAcp('cursor')).toBe(true);
    const spec = getAcpAdapter('cursor');
    expect(spec).not.toBeNull();
    // Native launcher: bare `cursor-agent` (PATH-resolved at spawn) OR an
    // absolute path to the resolved install binary (cursor-agent[.exe] —
    // the Windows stale-PATH fix); never the npm-adapter process.execPath.
    expect(
      spec?.command === 'cursor-agent' || /[\\/]cursor-agent(\.exe)?$/.test(spec?.command ?? ''),
    ).toBe(true);
    expect(spec?.args).toEqual(['acp']);
  });

  it('aider resolves NO adapter → PTY path', () => {
    expect(requiresAcp('aider')).toBe(false);
    expect(getAcpAdapter('aider')).toBeNull();
  });

  it('no env flag can disable ACP for adapter-backed agents', () => {
    // The legacy CODEAM_ACP_DISABLED / CODEAM_ACP_ENABLED flags were
    // removed — requiresAcp() is a pure function of the adapter
    // registry and ignores process.env entirely.
    process.env.CODEAM_ACP_DISABLED = '1';
    process.env.CODEAM_ACP_ENABLED = '0';
    expect(requiresAcp('claude')).toBe(true);
    expect(requiresAcp('codex')).toBe(true);
  });

  it('requiresAcp stays true for claude/codex/gemini/cursor even when module resolution is BROKEN', () => {
    // Regression test for the 2026-07-17 incident: an npm global reinstall
    // race transiently deleted `@agentclientprotocol/claude-agent-acp`
    // on-disk while a codespace daemon was live. `getAcpAdapter`'s internal
    // `resolveBin()` calls `require.resolve(...)`, which bottoms out in
    // Node's `Module._resolveFilename` — hook that EXACT seam to reproduce a
    // real "package not found" failure without touching the real
    // node_modules tree (which other test files/workers may be resolving
    // concurrently).
    resetAcpAdapterCacheForTests();
    const ModuleAny = Module as unknown as { _resolveFilename: ResolveFilename };
    const real = ModuleAny._resolveFilename;
    ModuleAny._resolveFilename = ((request: string, ...rest: unknown[]) => {
      if (request.includes('claude-agent-acp') || request.includes('codex-acp')) {
        throw new Error(`Cannot find module '${request}' (simulated reinstall race)`);
      }
      return real.apply(Module, [request, ...rest]);
    }) as ResolveFilename;
    try {
      // The adapter genuinely fails to resolve while the hook is active —
      // proves this is exercising the broken path, not a stale cache hit.
      expect(getAcpAdapter('claude')).toBeNull();
      expect(getAcpAdapter('codex')).toBeNull();

      // ...yet the STATIC dispatch predicate is unaffected for every
      // ACP-required agent, including ones that don't even go through
      // `resolveBin` (gemini/cursor are native-ACP, no npm package) — the
      // point is `requiresAcp` never touches resolution AT ALL.
      expect(requiresAcp('claude')).toBe(true);
      expect(requiresAcp('codex')).toBe(true);
      expect(requiresAcp('gemini')).toBe(true);
      expect(requiresAcp('cursor')).toBe(true);
    } finally {
      ModuleAny._resolveFilename = real;
      resetAcpAdapterCacheForTests();
    }
  });
});

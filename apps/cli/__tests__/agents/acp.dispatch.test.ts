import { describe, it, expect, afterEach } from 'vitest';
import { requiresAcp, getAcpAdapter } from '../../src/agents/acp/adapters';

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

  it('aider and cursor resolve NO adapter → PTY path', () => {
    expect(requiresAcp('aider')).toBe(false);
    expect(requiresAcp('cursor')).toBe(false);
    expect(getAcpAdapter('aider')).toBeNull();
    expect(getAcpAdapter('cursor')).toBeNull();
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
});

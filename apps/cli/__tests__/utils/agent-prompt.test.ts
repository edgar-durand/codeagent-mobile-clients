import { describe, it, expect } from 'vitest';
import { parseAgentFlag } from '../../src/utils/agent-prompt';

describe('parseAgentFlag', () => {
  it('returns claude for --agent=claude', () => {
    expect(parseAgentFlag(['--agent=claude'])).toBe('claude');
  });

  it('returns null when no flag', () => {
    expect(parseAgentFlag(['--other=x'])).toBeNull();
  });

  it('returns null for empty args', () => {
    expect(parseAgentFlag([])).toBeNull();
  });

  it('throws on unknown agent value', () => {
    expect(() => parseAgentFlag(['--agent=zzz'])).toThrow(/invalid agent/i);
  });

  it('returns codex for --agent=codex (enabled in Phase 2)', () => {
    expect(parseAgentFlag(['--agent=codex'])).toBe('codex');
  });

  it('throws on disabled agent (copilot)', () => {
    expect(() => parseAgentFlag(['--agent=copilot'])).toThrow(/not.*available/i);
  });

  it('finds the flag regardless of position', () => {
    expect(parseAgentFlag(['--other', '--agent=claude', '--flag'])).toBe('claude');
  });
});

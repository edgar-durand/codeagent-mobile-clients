import { describe, it, expect } from 'vitest';
import { parseUsageOutput } from '../../src/agents/claude/quota';

describe('claude/quota parseUsageOutput', () => {
  it('extracts percent from "/usage" output', () => {
    const out = '... 42% used (resets Mon, May 19) ...';
    const result = parseUsageOutput(out);
    expect(result).not.toBeNull();
    expect(result!.percent).toBe(42);
    expect(result!.resetAt).toBe('Mon, May 19');
  });

  it('strips ANSI escape codes before matching', () => {
    const out = '\x1B[31m17%\x1B[0m used until reset';
    expect(parseUsageOutput(out)).toMatchObject({ percent: 17 });
  });

  it('returns null when no percent found', () => {
    expect(parseUsageOutput('garbage')).toBeNull();
  });

  it('returns just percent when reset line is missing', () => {
    expect(parseUsageOutput('5% used overall')).toEqual({ percent: 5, resetAt: undefined });
  });

  it('handles unicode chrome characters', () => {
    const out = '── 88% used\n   resets Wednesday at 9am';
    const result = parseUsageOutput(out);
    expect(result?.percent).toBe(88);
  });
});

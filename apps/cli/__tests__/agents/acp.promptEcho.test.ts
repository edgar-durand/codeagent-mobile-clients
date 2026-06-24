import { describe, it, expect } from 'vitest';
import { formatAgentReplyLine } from '../../src/agents/acp/promptEcho';

describe('formatAgentReplyLine', () => {
  it('renders a single collapsed line with the Agent label', () => {
    expect(formatAgentReplyLine('Hello!\n  How can I   help?')).toBe(
      '‹ Agent: Hello! How can I help?',
    );
  });

  it('returns empty string for empty / whitespace-only replies', () => {
    expect(formatAgentReplyLine('')).toBe('');
    expect(formatAgentReplyLine('   \n\t ')).toBe('');
  });

  it('truncates very long replies with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = formatAgentReplyLine(long);
    expect(out.startsWith('‹ Agent: ')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    // Bounded: label + cap + ellipsis, not the full 500 chars.
    expect(out.length).toBeLessThan(500);
  });
});

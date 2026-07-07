import { describe, it, expect } from 'vitest';
import { shouldOfferOneMRecovery } from '../../src/agents/acp/oneMContextRecovery';

describe('oneMContextRecovery', () => {
  it('detects the 1M-credits error in detail, stderr, or the reply text', () => {
    expect(
      shouldOfferOneMRecovery({ detail: 'Usage credits required for 1M context', recentStderr: '', finalText: '' }),
    ).toBe(true);
    expect(
      shouldOfferOneMRecovery({ detail: '', recentStderr: 'usage credits required for 1m context', finalText: '' }),
    ).toBe(true);
    expect(
      shouldOfferOneMRecovery({ detail: '', recentStderr: '', finalText: 'API Error: Usage credits required for 1M context' }),
    ).toBe(true);
  });

  it('does NOT match unrelated failures', () => {
    expect(shouldOfferOneMRecovery({ detail: 'socket hang up', recentStderr: '', finalText: '' })).toBe(false);
    expect(shouldOfferOneMRecovery({ detail: '401 unauthorized', recentStderr: '', finalText: '' })).toBe(false);
  });
});

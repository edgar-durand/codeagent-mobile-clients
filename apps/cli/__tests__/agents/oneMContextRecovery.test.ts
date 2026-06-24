import { describe, it, expect } from 'vitest';
import {
  ONE_M_DISABLE_OPTION,
  shouldOfferOneMRecovery,
  oneMRecoverySelectPrompt,
  makeOneMRecoveryState,
} from '../../src/agents/acp/oneMContextRecovery';

describe('oneMContextRecovery', () => {
  it('offers recovery when the 1M-credits error appears in detail, stderr, or the reply text', () => {
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

  it('does NOT offer recovery for unrelated failures', () => {
    expect(shouldOfferOneMRecovery({ detail: 'socket hang up', recentStderr: '', finalText: '' })).toBe(false);
    expect(shouldOfferOneMRecovery({ detail: '401 unauthorized', recentStderr: '', finalText: '' })).toBe(false);
  });

  it('the select prompt offers exactly the disable option + names 1M context', () => {
    const p = oneMRecoverySelectPrompt();
    expect(p.options).toEqual([ONE_M_DISABLE_OPTION]);
    expect(p.question.toLowerCase()).toContain('1m context');
  });

  it('state starts empty', () => {
    expect(makeOneMRecoveryState().pending).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { pickAllowOption } from '../../../src/agents/acp/runner';

describe('pickAllowOption — AUTO-mode permission auto-approve', () => {
  it('prefers allow_always over allow_once', () => {
    const opts = [
      { optionId: 'o1', kind: 'allow_once' },
      { optionId: 'o2', kind: 'allow_always' },
      { optionId: 'o3', kind: 'reject_once' },
    ];
    expect(pickAllowOption(opts)?.optionId).toBe('o2');
  });

  it('falls back to allow_once when no allow_always', () => {
    const opts = [
      { optionId: 'o1', kind: 'reject_always' },
      { optionId: 'o2', kind: 'allow_once' },
    ];
    expect(pickAllowOption(opts)?.optionId).toBe('o2');
  });

  it('returns null when only reject options are offered (→ caller goes interactive)', () => {
    const opts = [
      { optionId: 'o1', kind: 'reject_once' },
      { optionId: 'o2', kind: 'reject_always' },
    ];
    expect(pickAllowOption(opts)).toBeNull();
  });

  it('returns null for an empty option list', () => {
    expect(pickAllowOption([])).toBeNull();
  });
});

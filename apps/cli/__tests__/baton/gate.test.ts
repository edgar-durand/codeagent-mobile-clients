import { describe, it, expect } from 'vitest';
import { isLocalSession } from '../../src/baton/gate';

describe('isLocalSession', () => {
  it('is true for a bare local env', () => {
    expect(isLocalSession({})).toBe(true);
  });

  it.each([
    ['CODESPACES', 'true'],
    ['CODEAM_AUTO_APPROVE', '1'],
    ['HEADROOM_ENABLED', '1'],
    ['CODEAM_AUTO_TOKEN', 'x'],
    ['CODEAM_ENROLL_TOKEN', 'x'],
  ])('is false when %s=%s (cloud/self-hosted)', (k, v) => {
    expect(isLocalSession({ [k]: v })).toBe(false);
  });
});


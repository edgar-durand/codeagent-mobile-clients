import { describe, it, expect } from 'vitest';
import { isLocalSession, batonEnabled } from '../../src/baton/gate';

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

describe('batonEnabled', () => {
  it('is true by default (ON for local sessions)', () => expect(batonEnabled({})).toBe(true));

  it('is true for CODEAM_BATON=1', () => expect(batonEnabled({ CODEAM_BATON: '1' })).toBe(true));

  it('is true for an empty string (unset-equivalent)', () =>
    expect(batonEnabled({ CODEAM_BATON: '' })).toBe(true));

  it('is false for the kill switch CODEAM_BATON=0 / false', () => {
    expect(batonEnabled({ CODEAM_BATON: '0' })).toBe(false);
    expect(batonEnabled({ CODEAM_BATON: 'false' })).toBe(false);
    expect(batonEnabled({ CODEAM_BATON: 'FALSE' })).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { isLocalSession, runtimeSupportsBaton } from '../../src/baton/gate';

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

describe('runtimeSupportsBaton', () => {
  it('is true for a runtime that implements resolveHistoryFile (claude/codex/cursor)', () => {
    expect(runtimeSupportsBaton({ resolveHistoryFile: () => null })).toBe(true);
  });

  it('is false for a runtime without resolveHistoryFile (gemini/aider → no baton)', () => {
    expect(runtimeSupportsBaton({})).toBe(false);
    expect(runtimeSupportsBaton({ resolveHistoryFile: undefined })).toBe(false);
  });
});


import { describe, it, expect } from 'vitest';
import { looksLikeAuthFailure } from '../../src/agents/acp/runner';

describe('looksLikeAuthFailure — classify a credential 401 vs benign output', () => {
  it('matches the canonical Claude expired-credential stderr', () => {
    // The exact line a user sees when the Claude token is expired.
    expect(
      looksLikeAuthFailure('Failed to authenticate. API Error: 401 Invalid authentication credentials'),
    ).toBe(true);
  });

  it('matches the common provider auth phrasings', () => {
    expect(looksLikeAuthFailure('Please run /login to authenticate')).toBe(true);
    expect(looksLikeAuthFailure('HTTP 401 Unauthorized')).toBe(true);
    expect(looksLikeAuthFailure('authentication_error: invalid x-api-key')).toBe(true);
    expect(looksLikeAuthFailure('oauth token expired')).toBe(true);
  });

  it('does NOT match benign agent output', () => {
    expect(looksLikeAuthFailure('Edited file at line 4015')).toBe(false);
    expect(looksLikeAuthFailure('Compiled 401 modules successfully')).toBe(false);
    expect(looksLikeAuthFailure('All tests passed')).toBe(false);
    expect(looksLikeAuthFailure('')).toBe(false);
  });
});

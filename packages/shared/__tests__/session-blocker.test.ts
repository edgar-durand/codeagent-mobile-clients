import { describe, expect, it } from 'vitest';
import { SESSION_BLOCKER_KINDS, toSessionBlocker } from '../src';

describe('toSessionBlocker — the typed blocker tag on a failure bubble', () => {
  it('accepts every kind, with the optional agent / provider', () => {
    for (const kind of SESSION_BLOCKER_KINDS) {
      expect(toSessionBlocker({ kind })).toEqual({ kind });
    }
    expect(toSessionBlocker({ kind: 'provider_credits_exhausted', provider: 'OpenRouter' })).toEqual({
      kind: 'provider_credits_exhausted',
      provider: 'OpenRouter',
    });
  });

  it('rejects anything else as null (absent, unknown kind, oversized fields)', () => {
    expect(toSessionBlocker(undefined)).toBeNull();
    expect(toSessionBlocker('house_agent_limit')).toBeNull();
    expect(toSessionBlocker({ kind: 'something_new' })).toBeNull();
    expect(toSessionBlocker({ kind: 'agent_auth_failed', agentId: 'x'.repeat(65) })).toBeNull();
  });
});

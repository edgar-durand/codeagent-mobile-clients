import { describe, it, expect, vi } from 'vitest';
import { validateClaudeToken } from '../src/agents/claude/link';
import type { LocalAgentToken } from '../src/agents/strategy';

const tok = (over: Partial<LocalAgentToken>): LocalAgentToken =>
  ({ method: 'oauth', credential: '', source: 'flat-file', ...over }) as LocalAgentToken;

const cred = (o: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: o });

describe('validateClaudeToken', () => {
  it('valid when the access token has not expired', () => {
    const c = tok({ credential: cred({ expiresAt: Date.now() + 3_600_000, refreshToken: 'r' }) });
    expect(validateClaudeToken(c).status).toBe('valid');
  });

  it('unknown (recoverable) when expired BUT a refresh token is present', () => {
    // Expired access + refresh token → Claude refreshes on use; never block.
    const c = tok({ credential: cred({ expiresAt: Date.now() - 1000, refreshToken: 'r' }) });
    expect(validateClaudeToken(c).status).toBe('unknown');
  });

  it('expired when the access token is expired AND no refresh token', () => {
    const c = tok({ credential: cred({ expiresAt: Date.now() - 1000, refreshToken: '' }) });
    expect(validateClaudeToken(c).status).toBe('expired');
  });

  it('unknown for api_key / unparseable / clockless blobs (never blocks)', () => {
    expect(validateClaudeToken(tok({ method: 'api_key', credential: 'sk-ant' })).status).toBe('unknown');
    expect(validateClaudeToken(tok({ credential: 'not json' })).status).toBe('unknown');
    expect(validateClaudeToken(tok({ credential: cred({ refreshToken: 'r' }) })).status).toBe('unknown');
  });
});

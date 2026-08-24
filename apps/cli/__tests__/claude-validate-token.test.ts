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
    // ⚠️ The fixture now carries an accessToken, which is what the test's own
    // name describes. It did not before, so it was really asserting on a blob
    // with NO tokens at all — and that shape is the house-agent PLACEHOLDER
    // (`{expiresAt: 0}`, no tokens), which must be `unknown`: reading it as
    // expired fired the re-auth bubble on every new CodeAgent Cloud session
    // while the agent worked fine (2026-08-24). See
    // `claude.placeholder-credential.test.ts`, which pins both shapes.
    const c = tok({
      credential: cred({ expiresAt: Date.now() - 1000, accessToken: 'a', refreshToken: '' }),
    });
    expect(validateClaudeToken(c).status).toBe('expired');
  });

  it('unknown for api_key / unparseable / clockless blobs (never blocks)', () => {
    expect(validateClaudeToken(tok({ method: 'api_key', credential: 'sk-ant' })).status).toBe('unknown');
    expect(validateClaudeToken(tok({ credential: 'not json' })).status).toBe('unknown');
    expect(validateClaudeToken(tok({ credential: cred({ refreshToken: 'r' }) })).status).toBe('unknown');
  });
});

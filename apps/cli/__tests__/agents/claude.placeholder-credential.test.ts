import { describe, it, expect, afterEach } from 'vitest';
import { validateClaudeToken } from '../../src/agents/claude/link';

/**
 * An EMPTY credential file is not an expired credential.
 *
 * WHY THIS EXISTS — edgar@privacyhawk.com, 2026-08-24. Every session he
 * deployed on the CodeAgent Cloud (house) agent showed, seconds after start
 * and while the agent worked perfectly:
 *
 *   🔒 Authentication failed — your agent credentials are invalid or expired
 *
 * `wakeCredentialProbe` runs at the readiness seam and asks
 * `localCredentialExpiryStatus('claude')`, which reads
 * `~/.claude/.credentials.json`. But a HOUSE-agent session does not
 * authenticate with that file at all — it uses `ANTHROPIC_BASE_URL` +
 * `ANTHROPIC_AUTH_TOKEN` against our metered proxy (verified live: that token
 * was minted 60 s earlier, valid for 30 days, and answered 200 when replayed
 * from the box). The file is a placeholder the house agent never fills in:
 *
 *   claudeAiOauth.expiresAt : 0
 *   accessToken             : absent
 *   refreshToken            : absent
 *
 * `validateClaudeToken` saw `expiresAt` in the past and no refresh token and
 * called it `expired` — the one status the probe acts on. So the probe fired
 * on a credential the agent does not use, on every new session, and because it
 * is network-free there was no 401 anywhere to explain it (our proxy served
 * only 200s and never returned a 401 in 24 h).
 *
 * `expiresAt: 0` with NO tokens at all is the ABSENCE of a local credential,
 * which the module's own contract already calls `unknown` — "we NEVER
 * false-trigger a re-auth on a working credential".
 */
const oauth = (fields: Record<string, unknown>): Parameters<typeof validateClaudeToken>[0] =>
  ({ method: 'oauth', credential: JSON.stringify({ claudeAiOauth: fields }) }) as never;

describe('validateClaudeToken — placeholder credential files', () => {
  it('does not call the house-agent placeholder expired', () => {
    // THE BUG, byte-for-byte what was on the user's box.
    expect(validateClaudeToken(oauth({ expiresAt: 0, subscriptionType: 'team' })).status).toBe(
      'unknown',
    );
  });

  it('is unknown when the blob carries no tokens at all', () => {
    expect(validateClaudeToken(oauth({ expiresAt: 1 })).status).toBe('unknown');
  });

  // The real case this probe exists for must still fire: a session that HAD a
  // token, whose access token lapsed while the codespace slept, with nothing to
  // refresh it with.
  it('still reports a genuinely lapsed credential as expired', () => {
    expect(
      validateClaudeToken(
        oauth({ expiresAt: Date.now() - 60_000, accessToken: 'sk-ant-oat-xxx' }),
      ).status,
    ).toBe('expired');
  });

  it('leaves a refreshable credential alone', () => {
    expect(
      validateClaudeToken(
        oauth({
          expiresAt: Date.now() - 60_000,
          accessToken: 'sk-ant-oat-xxx',
          refreshToken: 'sk-ant-ort-yyy',
        }),
      ).status,
    ).toBe('unknown');
  });

  it('leaves a live credential alone', () => {
    expect(
      validateClaudeToken(
        oauth({ expiresAt: Date.now() + 3_600_000, accessToken: 'sk-ant-oat-xxx' }),
      ).status,
    ).toBe('valid');
  });
});

/**
 * Second guard: a session authenticating through the house proxy has no local
 * credential to judge in the first place.
 *
 * The placeholder fix above stops the false positive at the file level, but the
 * probe should not even look when the agent is not using that file — its whole
 * premise ("the OAuth token may have expired while the codespace slept") is
 * about a credential this session never touches.
 */
describe('localCredentialExpiryStatus — house-agent sessions', () => {
  const ORIGINAL = process.env.ANTHROPIC_BASE_URL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = ORIGINAL;
  });

  it('skips the local check when the agent routes through our proxy', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.codeagent-mobile.com/api/v1/agent-proxy';
    const { localCredentialExpiryStatus } = await import(
      '../../src/agents/acp/wakeCredentialProbe'
    );
    await expect(localCredentialExpiryStatus('claude')).resolves.toBe('unknown');
  });

  it('still checks locally when nothing redirects the agent', async () => {
    delete process.env.ANTHROPIC_BASE_URL;
    const { usesHouseProxy } = await import('../../src/agents/acp/wakeCredentialProbe');
    expect(usesHouseProxy()).toBe(false);
  });

  // Headroom also rewrites the base URL, to a LOCAL address. That one is a
  // compression hop in front of the user's own credential, so the local check
  // still applies.
  it('does not mistake the Headroom hop for the house proxy', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:8787';
    const { usesHouseProxy } = await import('../../src/agents/acp/wakeCredentialProbe');
    expect(usesHouseProxy()).toBe(false);
  });
});

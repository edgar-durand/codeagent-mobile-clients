import { describe, it, expect } from 'vitest';
import {
  AUTH_FAILURE_MESSAGE,
  failureBubble,
  looksLikeAuthFailure,
  looksLikeLocalProxyUnavailable,
} from '../../src/agents/acp/failure-messages';

/**
 * A local Headroom proxy that is briefly down is NOT a bad credential.
 *
 * WHY THIS EXISTS — edgar@privacyhawk.com, 2026-08-24 21:53 UTC. He sent a
 * session off to resolve merge conflicts and got:
 *
 *   🔒 Authentication failed — your agent credentials are invalid or expired
 *      (API 401). Tap Re-authenticate this agent …
 *
 * Nothing was wrong with his credentials. The codespace CLI log shows, 0.4 s
 * before the CLI reported the credential invalid:
 *
 *   [warn] headroom-supervisor — proxy :8787 not answering before a turn —
 *          force-respawning + waiting for readiness
 *   [info] headroom-supervisor — proxy :8787 ready after ~9s
 *
 * Headroom rewrites the agent's own settings to route through
 * `http://127.0.0.1:8787`, so while the proxy is respawning every call the
 * agent makes fails to connect — and Claude Code wraps ANY API failure as
 * "Failed to authenticate. API Error: …", which `AUTH_FAILURE_RE` matches on
 * "failed to authenticate". Both of his sessions hit it at once (one waited
 * ~9 s, the other ~39 s) and the backend logged one
 * `POST /api/plugin/agents/claude/credential-invalid` per session. The proxy
 * then recovered and the turn ran normally — so the user was told to renew
 * credentials that were never broken, on a session that was working.
 *
 * This is the same misclassification already fixed for the house-proxy 403
 * (`looksLikeHouseAgentLimit`, the 2026-07-29 Rafael incident): re-auth can
 * never fix it, and every occurrence re-flags the credential as expired.
 */
describe('a local proxy that cannot be reached is not an auth failure', () => {
  // Shapes a failing connection to the Headroom proxy actually produces.
  const PROXY_DOWN = [
    'Failed to authenticate. API Error: connect ECONNREFUSED 127.0.0.1:8787',
    'fetch failed: connect ECONNREFUSED 127.0.0.1:8787',
    'Failed to authenticate. API Error: socket hang up (http://127.0.0.1:8787)',
    'request to http://localhost:8787/v1/messages failed, reason: ECONNREFUSED',
    'Error: connect ECONNRESET 127.0.0.1:8787',
  ];

  it.each(PROXY_DOWN)('recognises %s as the proxy being down', (text) => {
    expect(looksLikeLocalProxyUnavailable(text)).toBe(true);
  });

  it.each(PROXY_DOWN)('does NOT classify it as an auth failure: %s', (text) => {
    expect(looksLikeAuthFailure(text)).toBe(false);
  });

  it.each(PROXY_DOWN)('does NOT show the re-auth bubble for: %s', (text) => {
    const bubble = failureBubble({
      detail: text,
      recentStderr: '',
      hadText: false,
      agent: 'claude',
    });
    expect(bubble).not.toBe(AUTH_FAILURE_MESSAGE);
  });

  // The guard must be narrow. A genuinely expired credential still has to
  // reach the user — that bubble is the only way they learn to re-link.
  const REAL_AUTH = [
    'Failed to authenticate. API Error: 401 invalid x-api-key',
    'Not logged in · Please run /login',
    'OAuth token expired',
    'invalid authentication credentials',
  ];

  it.each(REAL_AUTH)('still flags a real credential failure: %s', (text) => {
    expect(looksLikeLocalProxyUnavailable(text)).toBe(false);
    expect(looksLikeAuthFailure(text)).toBe(true);
  });

  // A 401 that names the proxy address is still the proxy answering, not the
  // user's credential — but a bare 401 with no proxy in sight is real.
  it('does not let the proxy address turn a real 401 elsewhere into a false negative', () => {
    expect(looksLikeAuthFailure('API Error: 401 unauthorized')).toBe(true);
  });

  it('ignores an unrelated ECONNREFUSED with no proxy address', () => {
    // Some other service failing to connect is not a Headroom proxy problem,
    // and it was never an auth failure either.
    expect(looksLikeLocalProxyUnavailable('connect ECONNREFUSED 10.2.0.5:5432')).toBe(false);
  });
});

/**
 * The bubble asserted a status code it had never seen.
 *
 * `AUTH_FAILURE_MESSAGE` hard-coded "(API 401)", so every auth-ish failure —
 * including the proxy-down misclassification above — told the user the API had
 * answered 401. It sent this investigation looking for 401s in the proxy logs
 * that did not exist (there had been none in 24 h; the proxy was serving 200s
 * throughout). A message shown to a user should not claim a fact it does not
 * have.
 */
describe('AUTH_FAILURE_MESSAGE', () => {
  it('does not assert a status code it never observed', () => {
    expect(AUTH_FAILURE_MESSAGE).not.toContain('401');
  });

  it('still says what happened and what to do about it', () => {
    expect(AUTH_FAILURE_MESSAGE).toMatch(/authentication failed/i);
    expect(AUTH_FAILURE_MESSAGE).toContain('codeam://reauth');
  });
});

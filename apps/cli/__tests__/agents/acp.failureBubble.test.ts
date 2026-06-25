/**
 * Regression — a failed `start_task` turn must ALWAYS end with a VISIBLE
 * terminal frame, never silence.
 *
 * The bug (recurring "first message never answers" on a fresh codespace): the
 * first user prompt is the first real agent call routed through the local
 * Headroom proxy on :8787. If the proxy isn't ready (or any non-auth error
 * hits before a token streams), the runner's `recoverFromFailedTurn` →
 * `closeAll` publishes only an EMPTY `text done:true`. The mobile snapshot-guard
 * deliberately drops empty terminal frames, so the chat sits showing the
 * welcome card with NO reply and NO error — the user thinks the app is broken.
 *
 * `failureBubble` is the contract that prevents that: every non-text failure
 * yields a non-empty, actionable bubble the runner publishes with done:true.
 *
 * It also classifies a PROVIDER OUTAGE — but ONLY from the AGENT'S OWN error
 * (Anthropic 529 / upstream 5xx / "overloaded"). The provider's status page is
 * NOT consulted as a catch-all: a status-page incident can be live while this
 * user's local agent is still operational (partial/regional degradation, or a
 * stale/unrelated advisory). Surfacing a "service disruption" wall on a turn
 * the provider didn't actually reject is a false positive — so the agent's
 * error text is the sole trigger.
 */
import { describe, expect, it } from 'vitest';
import {
  failureBubble,
  AUTH_FAILURE_MESSAGE,
  TURN_FAILURE_MESSAGE,
  looksLikeProviderOutage,
  providerOutageMessage,
  agentStatusPage,
  replyIsAuthFailure,
  looksLike1mContextCreditsError,
  startupFailureMessage,
} from '../../src/agents/acp/runner';

describe('startupFailureMessage — agent-that-never-started surfaces an actionable reason', () => {
  const GEMINI_STDERR =
    'Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.';

  it('Gemini ineligible tier → explains the 2026-06-18 deprecation + API key / paid Code Assist', () => {
    const msg = startupFailureMessage('gemini', 'AGENT_STARTUP_FAILED', GEMINI_STDERR);
    expect(msg).toMatch(/Gemini/);
    expect(msg).toMatch(/2026-06-18|no longer|eligible/i);
    expect(msg).toMatch(/API key/i);
    expect(msg).toMatch(/Code Assist/i);
  });

  it('only applies the Gemini copy to gemini — other agents get a generic startup failure', () => {
    const msg = startupFailureMessage('codex', 'AGENT_STARTUP_TIMEOUT', 'some unrelated crash');
    expect(msg).toMatch(/codex/);
    expect(msg).toMatch(/failed to start/i);
    expect(msg).not.toMatch(/Code Assist/i);
  });

  it('non-gemini auth failure routes to the standard re-auth message', () => {
    const msg = startupFailureMessage('claude', 'invalid x-api-key 401 authentication_error', '');
    expect(msg).toBe(AUTH_FAILURE_MESSAGE);
  });
});

describe('failureBubble — every failed start_task ends with a visible terminal frame', () => {
  it('auth failure → the actionable re-auth bubble (regardless of streamed text)', () => {
    expect(
      failureBubble({
        detail: 'Internal error: API Error: 401 Invalid authentication credentials',
        recentStderr: '',
        hadText: false,
        agent: 'claude',
      }),
    ).toBe(AUTH_FAILURE_MESSAGE);
    // Auth signal can also arrive on stderr while some text streamed.
    expect(
      failureBubble({
        detail: 'boom',
        recentStderr: 'please run /login',
        hadText: true,
        agent: 'claude',
      }),
    ).toBe(AUTH_FAILURE_MESSAGE);
  });

  it('NON-auth failure with NO streamed text → generic retry bubble (the silent first-message bug)', () => {
    // The Headroom proxy not ready on :8787 — the exact first-prompt failure.
    expect(
      failureBubble({
        detail: 'connect ECONNREFUSED 127.0.0.1:8787',
        recentStderr: '',
        hadText: false,
        agent: 'claude',
      }),
    ).toBe(TURN_FAILURE_MESSAGE);
    // Any other non-auth error before text streams.
    expect(
      failureBubble({
        detail: 'Internal error: socket hang up',
        recentStderr: '',
        hadText: false,
        agent: 'claude',
      }),
    ).toBe(TURN_FAILURE_MESSAGE);
  });

  it('NON-auth failure that DID stream partial text → null (closeAll already published the partial reply)', () => {
    expect(
      failureBubble({
        detail: 'stream aborted mid-turn',
        recentStderr: '',
        hadText: true,
        agent: 'claude',
      }),
    ).toBeNull();
  });

  it('provider outage (Anthropic 529 / overloaded) → transparent outage bubble with status link, even with partial text', () => {
    const bubble = failureBubble({
      detail: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      recentStderr: '',
      hadText: true, // outage transparency wins over the partial-reply null-return
      agent: 'claude',
    });
    expect(bubble).toBe(providerOutageMessage('claude'));
    expect(bubble).toContain('Anthropic');
    expect(bubble).toContain('https://status.anthropic.com');
  });

  it('provider outage takes precedence over the generic no-text retry', () => {
    expect(
      failureBubble({
        detail: 'Service Unavailable',
        recentStderr: 'upstream connect error',
        hadText: false,
        agent: 'codex',
      }),
    ).toBe(providerOutageMessage('codex'));
  });

  it('the synthesized bubbles are NON-EMPTY so the mobile renders them (empty done:true is dropped)', () => {
    expect(TURN_FAILURE_MESSAGE.trim().length).toBeGreaterThan(0);
    expect(AUTH_FAILURE_MESSAGE.trim().length).toBeGreaterThan(0);
    expect(providerOutageMessage('claude').trim().length).toBeGreaterThan(0);
  });
});

describe('looksLikeProviderOutage', () => {
  it('detects upstream outage/overload signals', () => {
    for (const t of [
      'API Error: 529 overloaded_error',
      'overloaded_error',
      'HTTP 503 Service Unavailable',
      'status: 502 bad gateway',
      'upstream connect error',
      '504 gateway timeout',
    ]) {
      expect(looksLikeProviderOutage(t)).toBe(true);
    }
  });
  it('does NOT misclassify auth / user errors / generic timeouts as a provider outage', () => {
    for (const t of [
      'API Error: 401 Invalid authentication credentials',
      'connect ECONNREFUSED 127.0.0.1:8787',
      'Request timed out after 90000ms',
      'rate limit: 429 too many requests',
    ]) {
      expect(looksLikeProviderOutage(t)).toBe(false);
    }
  });
});

describe('agentStatusPage / providerOutageMessage', () => {
  it('resolves the provider + status URL per agent (runtime or public id)', () => {
    expect(agentStatusPage('claude')?.vendor).toBe('Anthropic');
    expect(agentStatusPage('claude_code')?.url).toBe('https://status.anthropic.com');
    expect(agentStatusPage('codex')?.vendor).toBe('OpenAI');
    expect(agentStatusPage('gemini')?.vendor).toBe('Google');
    expect(agentStatusPage('copilot')?.vendor).toBe('GitHub');
  });
  it('degrades gracefully (vendor-less, no link) for an unknown agent', () => {
    expect(agentStatusPage('mystery-agent')).toBeNull();
    const msg = providerOutageMessage('mystery-agent');
    expect(msg).toContain('The agent provider');
    expect(msg).not.toContain('https://');
  });
});

describe('outage verdict comes ONLY from the agent error, never the status page', () => {
  // Regression for the false "Anthropic is having a service disruption" wall
  // Rafael hit on a plain "Hola" (2026-06-24): the provider's status page had
  // a live (minor / unrelated) advisory, but his local agent was operational.
  // failureBubble must NOT manufacture an outage from anything other than the
  // agent's own provider-overload error — the status page is informational
  // (the link inside the bubble), not a trigger.
  it('a generic failure stays a generic retry — it is NEVER upgraded to an outage', () => {
    expect(
      failureBubble({
        detail: 'Internal error: socket hang up',
        recentStderr: 'some unrelated log line',
        hadText: false,
        agent: 'claude',
      }),
    ).toBe(TURN_FAILURE_MESSAGE);
  });
  it('a generic failure that already streamed text → null (no outage override)', () => {
    expect(
      failureBubble({
        detail: 'Request timed out after 90000ms',
        recentStderr: '',
        hadText: true,
        agent: 'claude',
      }),
    ).toBeNull();
  });
  it('only an actual provider-overload error yields the outage bubble', () => {
    expect(
      failureBubble({
        detail: 'API Error: 529 overloaded_error',
        recentStderr: '',
        hadText: false,
        agent: 'claude',
      }),
    ).toBe(providerOutageMessage('claude'));
  });
});

describe('replyIsAuthFailure — auth error arriving as a COMPLETED-turn reply', () => {
  // Rafael (2026-06-24): a codespace whose Claude wasn't logged in printed
  // "Not logged in · Please run /login" as a NORMAL assistant reply and ended
  // the turn cleanly — no throw, no process exit. Neither auth path fired, so
  // the raw CLI text leaked into the chat (and the credential was never flagged
  // EXPIRED). Detect it on the success path too.
  it('flags a short reply that IS the auth notice', () => {
    expect(replyIsAuthFailure('Not logged in · Please run /login')).toBe(true);
    expect(replyIsAuthFailure('  Please run /login  ')).toBe(true);
  });
  it('does NOT flag an empty reply', () => {
    expect(replyIsAuthFailure('')).toBe(false);
    expect(replyIsAuthFailure('   ')).toBe(false);
  });
  it('does NOT flag a substantive reply that merely DISCUSSES login (length guard)', () => {
    const longReply =
      'To authenticate the Claude CLI you run the login command. When you see ' +
      '"please run /login" it means your OAuth token expired, so open a terminal ' +
      'and run `claude /login`, complete the browser flow, and then re-run your ' +
      'task. This is unrelated to your actual prompt about the build pipeline, ' +
      'which I have now finished implementing across the three services.';
    expect(longReply.length).toBeGreaterThan(200);
    expect(replyIsAuthFailure(longReply)).toBe(false);
  });
  it('does NOT flag a normal short reply', () => {
    expect(replyIsAuthFailure('Done — pushed the commit.')).toBe(false);
  });
});

describe('looksLike1mContextCreditsError', () => {
  it('matches the 1M-context usage-credits error (Rafael 2026-06-24)', () => {
    for (const t of [
      'API Error: Usage credits required for 1M context · turn on usage credits at claude.ai/settings/usage, or use --model to switch to standard context',
      'usage credits required for 1m context',
      'Usage credits required for 1M context',
    ]) {
      expect(looksLike1mContextCreditsError(t)).toBe(true);
    }
  });
  it('does NOT match unrelated errors', () => {
    for (const t of [
      'API Error: 401 Invalid authentication credentials',
      'overloaded_error',
      'rate limit: 429 too many requests',
      'Usage limit reached',
    ]) {
      expect(looksLike1mContextCreditsError(t)).toBe(false);
    }
  });
});

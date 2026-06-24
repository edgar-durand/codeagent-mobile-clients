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
 * It also classifies a PROVIDER OUTAGE (Anthropic 529 / upstream 5xx) — the
 * leading cause of an agent that appears to "hang" — into a transparent
 * "provider is down" bubble with the provider's status-page link, so the user
 * never sees a silent stall during an upstream incident.
 */
import { describe, expect, it } from 'vitest';
import {
  failureBubble,
  AUTH_FAILURE_MESSAGE,
  TURN_FAILURE_MESSAGE,
  looksLikeProviderOutage,
  providerOutageMessage,
  agentStatusPage,
} from '../../src/agents/acp/runner';

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

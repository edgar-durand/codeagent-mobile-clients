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
  ONE_M_CREDITS_MESSAGE,
  TURN_FAILURE_MESSAGE,
  emptyReplyMessage,
  looksLikeProviderOutage,
  providerOutageMessage,
  agentStatusPage,
  replyIsAuthFailure,
  replyIsCursorUpgradeRequired,
  looksLike1mContextCreditsError,
  looksLikeBudgetExceeded,
  budgetBubbleMessage,
  startupFailureMessage,
  looksLikeAuthFailure,
  looksLikeHouseAgentLimit,
  replyIsHouseAgentLimit,
  houseAgentLimitMessage,
} from '../../src/agents/acp/runner';

describe('emptyReplyMessage — the honest bubble for a silently-empty end_turn', () => {
  it('names the agent + its binary for a known agent (kimi)', () => {
    const msg = emptyReplyMessage('kimi');
    expect(msg).toContain('Kimi Code');
    expect(msg).toContain('empty reply');
    expect(msg).toContain('`kimi -p "test"`');
  });

  it('falls back to the raw id for an unknown agent string', () => {
    const msg = emptyReplyMessage('some-future-agent');
    expect(msg).toContain('some-future-agent');
  });
});

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
    // Kimi's ACP session/new rejects an unprovisioned credential with the bare
    // JSON-RPC `-32000 Authentication required` — must route to the re-auth
    // bubble, not the raw "agent failed to start" dump.
    expect(
      failureBubble({
        detail: "method: 'session/new' { code: -32000, message: 'Authentication required' }",
        recentStderr: '',
        hadText: false,
        agent: 'kimi',
      }),
    ).toBe(AUTH_FAILURE_MESSAGE);
    // Claude's OAuth-refresh failure can also arrive as a thrown error / stderr
    // ("Failed to authenticate: OAuth session expired and could not be
    // refreshed") — same re-auth bubble, even with partial text streamed.
    expect(
      failureBubble({
        detail: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        recentStderr: '',
        hadText: false,
        agent: 'claude',
      }),
    ).toBe(AUTH_FAILURE_MESSAGE);
    expect(
      failureBubble({
        detail: 'boom',
        recentStderr: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        hadText: true,
        agent: 'claude',
      }),
    ).toBe(AUTH_FAILURE_MESSAGE);
  });

  it('1M-context usage-credits 429 → the reconnect-subscription bubble (not disable-1M)', () => {
    // Anthropic surfaces the credits gate as this error body; the recovery is
    // reconnecting the Claude subscription, so failureBubble must classify it
    // as ONE_M_CREDITS_MESSAGE rather than a generic retry.
    expect(
      failureBubble({
        detail: 'API Error: 429 Usage credits required for 1M context',
        recentStderr: '',
        hadText: false,
        agent: 'claude',
      }),
    ).toBe(ONE_M_CREDITS_MESSAGE);
    // Also when it arrives on stderr.
    expect(
      failureBubble({
        detail: 'boom',
        recentStderr: 'usage credits required for 1m context',
        hadText: false,
        agent: 'claude',
      }),
    ).toBe(ONE_M_CREDITS_MESSAGE);
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

  // Observed twice on a codespace review session: Claude's OAuth subscription
  // token could no longer be renewed and it printed the failure as a plain
  // completed-turn reply (no throw, no exit) — so it leaked as chat text with
  // NO reconnect CTA. Must be classified as an auth failure → re-auth bubble.
  it('flags the OAuth-refresh failure reply (Failed to authenticate: OAuth session expired…)', () => {
    expect(
      replyIsAuthFailure(
        'Failed to authenticate: OAuth session expired and could not be refreshed',
      ),
    ).toBe(true);
    // Its parts each anchor independently.
    expect(replyIsAuthFailure('OAuth session expired')).toBe(true);
    expect(replyIsAuthFailure('Failed to authenticate.')).toBe(true);
  });

  it('does NOT flag conversational prose that merely mentions OAuth / refreshing (no failure phrasing)', () => {
    // Short but clearly discussion, not a failure notice — none of the auth
    // failure anchors ("failed to authenticate", "oauth session expired",
    // "…could not be refreshed") appear.
    expect(
      replyIsAuthFailure(
        'Your OAuth token auto-refreshes in the background, so you rarely re-auth.',
      ),
    ).toBe(false);
    // Long prose about OAuth refresh — the ≤200-char guard also rejects it.
    const longReply =
      'When you authenticate with OAuth the CLI stores a refresh token and quietly ' +
      'renews your session before it expires. If it ever cannot be renewed you would ' +
      'be asked to log in again, but that is not happening here — I have finished the ' +
      'refactor across the three services and every test in the suite is now passing.';
    expect(longReply.length).toBeGreaterThan(200);
    expect(replyIsAuthFailure(longReply)).toBe(false);
  });
});

describe('replyIsCursorUpgradeRequired — Cursor plan paywall arriving as a reply', () => {
  // The user's Cursor account is on Free, which doesn't include the headless
  // Agent — cursor-agent ends the turn with "Upgrade your plan to continue".
  // Detect it (cursor-only at the call site) so we swap in an upgrade-link bubble.
  it('flags the Cursor upgrade paywall reply', () => {
    expect(replyIsCursorUpgradeRequired('Upgrade your plan to continue')).toBe(true);
    expect(replyIsCursorUpgradeRequired('\n\nUpgrade your plan to continue')).toBe(true);
    expect(replyIsCursorUpgradeRequired('UPGRADE YOUR PLAN TO CONTINUE')).toBe(true);
  });
  it('does NOT flag empty / normal / long replies (length guard)', () => {
    expect(replyIsCursorUpgradeRequired('')).toBe(false);
    expect(replyIsCursorUpgradeRequired('Done — pushed the commit.')).toBe(false);
    const longReply =
      'You can upgrade your plan to continue getting more usage, but for now I ' +
      'have finished the refactor you asked for across all the services and the ' +
      'tests pass. Let me know if you want me to also update the docs and the ' +
      'changelog before we open the pull request for review by your teammates.';
    expect(longReply.length).toBeGreaterThan(200);
    expect(replyIsCursorUpgradeRequired(longReply)).toBe(false);
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

// ─── Budget-exceeded detection ────────────────────────────────────────────────

describe('looksLikeBudgetExceeded', () => {
  it('matches the LIVE headroom 429 body (verified 2026-06-28)', () => {
    // headroom proxy --budget 0 --budget-period daily
    // → HTTP 429 {"detail":"Budget exceeded for daily period"}
    expect(looksLikeBudgetExceeded('{"detail":"Budget exceeded for daily period"}')).toBe(true);
    expect(looksLikeBudgetExceeded('Budget exceeded for daily period')).toBe(true);
    expect(looksLikeBudgetExceeded('Budget exceeded for hourly period')).toBe(true);
    expect(looksLikeBudgetExceeded('Budget exceeded for monthly period')).toBe(true);
  });

  it('does NOT match unrelated 429s (rate limit, 1M, auth, outage)', () => {
    for (const t of [
      'rate limit: 429 too many requests',
      'Usage credits required for 1M context',
      'API Error: 401 Invalid authentication credentials',
      'overloaded_error',
      'connect ECONNREFUSED 127.0.0.1:8787',
    ]) {
      expect(looksLikeBudgetExceeded(t)).toBe(false);
    }
  });
});

describe('failureBubble — budget-exceeded branch', () => {
  // REGRESSION: budget-exceeded must return its own bubble (NOT the outage bubble,
  // NOT the generic retry). The proxy is local; the agent provider is healthy.
  // Budget is checked BEFORE outage so a 429 from localhost:8787 is never
  // mis-classified as a "Anthropic service disruption".

  it('budget 429 in detail → budget bubble (NOT outage, NOT generic retry)', () => {
    const bubble = failureBubble({
      detail: 'Budget exceeded for daily period',
      recentStderr: '',
      hadText: false,
      agent: 'claude',
    });
    expect(bubble).toBe(budgetBubbleMessage('claude', 'daily'));
    expect(bubble).not.toBe(providerOutageMessage('claude'));
    expect(bubble).not.toBe(TURN_FAILURE_MESSAGE);
  });

  it('budget 429 in recentStderr → budget bubble', () => {
    const bubble = failureBubble({
      detail: 'connect ECONNREFUSED 127.0.0.1:8787',
      recentStderr: 'Budget exceeded for hourly period',
      hadText: false,
      agent: 'codex',
    });
    expect(bubble).toBe(budgetBubbleMessage('codex', 'hourly'));
  });

  it('budget 429 with partial text → still returns budget bubble (not null)', () => {
    // Unlike the generic retry path (which returns null when hadText=true),
    // the budget path always surfaces its bubble so the user knows why it stopped.
    const bubble = failureBubble({
      detail: 'Budget exceeded for monthly period',
      recentStderr: '',
      hadText: true,
      agent: 'claude',
    });
    expect(bubble).toBe(budgetBubbleMessage('claude', 'monthly'));
  });

  it('NON-budget non-auth failure with no text → still returns generic retry (regression guard)', () => {
    expect(
      failureBubble({
        detail: 'connect ECONNREFUSED 127.0.0.1:8787',
        recentStderr: '',
        hadText: false,
        agent: 'claude',
      }),
    ).toBe(TURN_FAILURE_MESSAGE);
  });

  it('auth failure takes precedence over everything — unchanged (regression guard)', () => {
    expect(
      failureBubble({
        detail: 'API Error: 401 Invalid authentication credentials',
        recentStderr: '',
        hadText: false,
        agent: 'claude',
      }),
    ).toBe(AUTH_FAILURE_MESSAGE);
  });

  it('outage 529 (no budget signal) → outage bubble (unchanged — regression guard)', () => {
    expect(
      failureBubble({
        detail: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
        recentStderr: '',
        hadText: false,
        agent: 'claude',
      }),
    ).toBe(providerOutageMessage('claude'));
  });
});

describe('house-agent 403 (CodeAgent Cloud ceiling) is NOT an auth failure', () => {
  // The exact strings our agent-proxy returns (agent-proxy.controller.ts /
  // agent-proxy-meter.service.ts), as Claude Code's SDK surfaces them:
  // "Internal error: Failed to authenticate. API Error: 403 <body>".
  const FREE_CEILING =
    'Internal error: Failed to authenticate. API Error: 403 Daily CodeAgent Cloud usage ceiling reached. Upgrade to Pro for more.';
  const PRO_CEILING =
    'Internal error: Failed to authenticate. API Error: 403 Daily CodeAgent Cloud usage ceiling reached — resets at midnight UTC.';
  const UNAVAILABLE =
    'Internal error: Failed to authenticate. API Error: 403 CodeAgent Cloud is temporarily unavailable.';
  const DISABLED =
    'Internal error: Failed to authenticate. API Error: 403 CodeAgent Cloud is temporarily disabled.';

  it('detector matches every house-proxy 403 variant', () => {
    for (const t of [FREE_CEILING, PRO_CEILING, UNAVAILABLE, DISABLED]) {
      expect(looksLikeHouseAgentLimit(t)).toBe(true);
    }
    // and the raw HOUSE_AGENT_CEILING code shape
    expect(looksLikeHouseAgentLimit('code: HOUSE_AGENT_CEILING')).toBe(true);
  });

  it('the ceiling 403 is NOT classified as an auth failure (the whole bug)', () => {
    // Without the guard, "failed to authenticate" would match AUTH_FAILURE_RE.
    expect(looksLikeAuthFailure(FREE_CEILING)).toBe(false);
    expect(looksLikeAuthFailure(PRO_CEILING)).toBe(false);
    expect(looksLikeAuthFailure(UNAVAILABLE)).toBe(false);
    // A genuine credential 401 still classifies as an auth failure.
    expect(looksLikeAuthFailure('API Error: 401 invalid authentication credentials')).toBe(true);
  });

  it('failureBubble surfaces the daily-limit bubble, never the re-auth bubble', () => {
    const bubble = failureBubble({
      detail: PRO_CEILING,
      recentStderr: '',
      hadText: false,
      agent: 'claude',
    });
    expect(bubble).toBe(houseAgentLimitMessage(PRO_CEILING));
    expect(bubble).not.toBe(AUTH_FAILURE_MESSAGE);
    expect(bubble).toMatch(/daily CodeAgent Cloud limit/i);
    // Must NOT tell the user their login is broken.
    expect(bubble).not.toMatch(/re-?authenticate|codeam:\/\/reauth/i);
  });

  it('FREE ceiling body keeps the upgrade CTA; PRO ceiling does not', () => {
    expect(houseAgentLimitMessage(FREE_CEILING)).toMatch(/upgrade to \*\*pro\*\*/i);
    expect(houseAgentLimitMessage(PRO_CEILING)).not.toMatch(/upgrade to \*\*pro\*\*/i);
    expect(houseAgentLimitMessage(PRO_CEILING)).toMatch(/wait for the reset/i);
  });

  it('temporarily-unavailable gets the availability bubble, not the ceiling one', () => {
    const msg = houseAgentLimitMessage(UNAVAILABLE);
    expect(msg).toMatch(/temporarily unavailable/i);
    expect(msg).not.toMatch(/daily/i);
  });

  it('the ceiling arriving as a COMPLETED reply is caught before replyIsAuthFailure', () => {
    // Rafael's reply text — short, single line — must route to the house path,
    // NOT the auth-in-reply path (which would fire reportCredentialInvalid).
    expect(replyIsHouseAgentLimit(PRO_CEILING)).toBe(true);
    expect(replyIsAuthFailure(PRO_CEILING)).toBe(false);
  });

  it('a long reply that merely mentions the product is not misclassified', () => {
    const prose =
      'CodeAgent Cloud is a great option. '.repeat(20) +
      'You could hit a usage ceiling eventually.';
    expect(replyIsHouseAgentLimit(prose)).toBe(false); // > 300 chars
  });
});

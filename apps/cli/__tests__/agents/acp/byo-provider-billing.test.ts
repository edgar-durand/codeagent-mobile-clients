/**
 * codeagent-tvqt — a BYO provider 402 gets its own typed bubble.
 *
 * Live 2026-09-23: a house agent deployed as `openrouter` with the user's OWN
 * $0 OpenRouter key; Claude Code on the box logged
 * `API Error: 402 Insufficient credits. Add more using
 * https://openrouter.ai/settings/credits` and the reply chain would have read
 * the "Failed to authenticate." wrapper as an auth failure. Our agent-proxy
 * converts upstream 402s to 503, so a literal "402 Insufficient credits" is
 * ALWAYS a BYO provider — and on the house rail this bubble must never show.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTH_FAILURE_MESSAGE,
  byoProviderBillingMessage,
  byoProviderName,
  completedReplyFailureBubble,
  failureBubble,
  looksLikeByoProviderBilling,
  replyIsByoProviderBilling,
} from '../../../src/agents/acp/failure-messages';

const LIVE_LINE =
  'Failed to authenticate. API Error: 402 Insufficient credits. Add more using https://openrouter.ai/settings/credits';
const BYO_ENV = { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1', ANTHROPIC_API_KEY: 'sk-or-x' };
const HOUSE_ENV = {
  ANTHROPIC_BASE_URL: 'https://api.codeagent-mobile.com/api/v1/agent-proxy',
  ANTHROPIC_AUTH_TOKEN: 'house-tok',
};

describe('looksLikeByoProviderBilling / replyIsByoProviderBilling', () => {
  it.each([
    LIVE_LINE,
    'API Error: 402 insufficient balance (1008)',
    'status 402: Insufficient credits',
    'Insufficient credits — HTTP 402',
  ])('matches %j off the house rail', (line) => {
    expect(looksLikeByoProviderBilling(line, BYO_ENV)).toBe(true);
    expect(looksLikeByoProviderBilling(line, {})).toBe(true);
  });

  it('never matches on the house-proxy env, whatever the text', () => {
    expect(looksLikeByoProviderBilling(LIVE_LINE, HOUSE_ENV)).toBe(false);
    expect(replyIsByoProviderBilling(LIVE_LINE, HOUSE_ENV)).toBe(false);
  });

  it.each([
    'API Error: 401 Unauthorized',
    'API Error: 403 HOUSE_AGENT_CEILING',
    'issue #402 is about insufficient tests',
    'Insufficient credits are discussed in docs/billing.md line 402 of the diff below\n'.repeat(12),
  ])('does not match %j', (line) => {
    expect(replyIsByoProviderBilling(line, BYO_ENV)).toBe(false);
  });
});

describe('byoProviderName', () => {
  it('names known hosts from the base-URL env (redacted origin), verbatim host otherwise', () => {
    expect(byoProviderName({ env: BYO_ENV })).toBe('OpenRouter');
    expect(byoProviderName({ env: { ANTHROPIC_BASE_URL: 'https://api.deepinfra.com/v1/openai' } })).toBe('DeepInfra');
    expect(byoProviderName({ env: { OPENAI_BASE_URL: 'https://api.openai.com/v1' } })).toBe('OpenAI');
    expect(byoProviderName({ env: { ANTHROPIC_BASE_URL: 'https://llm.corp.example:8443/v1?k=sk-x' } })).toBe('llm.corp.example');
  });

  it('falls back to the agent default vendor, then to "provider"', () => {
    expect(byoProviderName({ env: {}, agent: 'claude' })).toBe('Anthropic');
    expect(byoProviderName({ env: {}, agent: 'codex' })).toBe('OpenAI');
    expect(byoProviderName({ env: {}, agent: 'kimi' })).toBe('provider');
    expect(byoProviderName({ env: { ANTHROPIC_BASE_URL: 'garbage' }, agent: 'kimi' })).toBe('provider');
  });
});

describe('failureBubble — BYO provider 402', () => {
  it('BYO: names the provider and says top up / switch agent — not the re-auth bubble', () => {
    const bubble = failureBubble({
      detail: LIVE_LINE,
      recentStderr: '',
      hadText: false,
      agent: 'claude',
      env: BYO_ENV,
    });
    expect(bubble).toBe(byoProviderBillingMessage('OpenRouter'));
    expect(bubble).toContain('Your OpenRouter account has no credits left.');
    expect(bubble).toContain('Top up at your provider, or switch this session to another agent.');
    expect(bubble).not.toBe(AUTH_FAILURE_MESSAGE);
  });

  it('BYO via stderr only (the detail was generic) still classifies', () => {
    const bubble = failureBubble({
      detail: 'prompt failed',
      recentStderr: `warn: retrying\n${LIVE_LINE}`,
      hadText: true,
      agent: 'claude',
      env: BYO_ENV,
    });
    expect(bubble).toContain('no credits left');
  });

  it('house proxy: the SAME text must NOT get the BYO bubble', () => {
    const bubble = failureBubble({
      detail: LIVE_LINE,
      recentStderr: '',
      hadText: false,
      agent: 'claude',
      env: HOUSE_ENV,
    });
    expect(bubble ?? '').not.toContain('no credits left');
  });
});

describe('completedReplyFailureBubble (shared by start_task + Agent Pack stages)', () => {
  it('turns a BYO 402 reply into the top-up bubble, and a real reply into null', () => {
    expect(completedReplyFailureBubble({ finalText: LIVE_LINE, agent: 'claude', env: BYO_ENV })).toBe(
      byoProviderBillingMessage('OpenRouter'),
    );
    expect(
      completedReplyFailureBubble({ finalText: 'Done — 3 files changed.\n\n## Handoff\nok', agent: 'claude', env: BYO_ENV }),
    ).toBeNull();
  });

  it('house proxy env: a 402-shaped reply is not the BYO bubble', () => {
    const out = completedReplyFailureBubble({ finalText: LIVE_LINE, agent: 'claude', env: HOUSE_ENV });
    expect(out ?? '').not.toContain('no credits left');
  });

  it('still classifies a plain auth failure reply', () => {
    expect(
      completedReplyFailureBubble({ finalText: 'Not logged in · Please run /login', agent: 'claude', env: {} }),
    ).toBe(AUTH_FAILURE_MESSAGE);
  });
});

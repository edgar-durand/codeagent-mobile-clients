/**
 * A provider that ran out of credits gets the honest "top up or switch agent"
 * bubble, never the outage, re-auth or generic-retry one.
 *
 * Web replay 2026-09-27 (user on an OpenRouter-backed agent): every turn
 * failed with OpenRouter's "requires more credits" and the raw text + key URL
 * reached the chat. The matcher only knew wordings sitting next to a literal
 * `402`, and it read the deploy-time `process.env`, which after a house → BYO
 * switch still carries the house-proxy keys (bubble suppressed) and lacks the
 * switched-to base URL (wrong provider named).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_FAILURE_MESSAGE,
  ONE_M_CREDITS_MESSAGE,
  TURN_FAILURE_MESSAGE,
  byoProviderBillingMessage,
  completedReplyFailureBubble,
  failureBubble,
  looksLikeByoProviderBilling,
  providerOutageMessage,
  replyIsByoProviderBilling,
} from '../../src/agents/acp/failure-messages';
import { resetCurrentAgentEnvForTests, setCurrentAgentEnv } from '../../src/agents/current-agent-env';

const BYO_ENV = { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1', ANTHROPIC_API_KEY: 'sk-or-x' };
const HOUSE_ENV = {
  ANTHROPIC_BASE_URL: 'https://api.codeagent-mobile.com/api/v1/agent-proxy',
  ANTHROPIC_AUTH_TOKEN: 'house-tok',
};

// Provider wordings that carry NO status code next to them.
const OPENROUTER_KEY_LIMIT =
  'This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 1416. To increase, visit https://openrouter.ai/settings/keys and create a key with a higher total limit';
const OPENROUTER_JSON_BODY =
  '{"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}';
const ANTHROPIC_LOW_BALANCE =
  'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
const CLAUDE_CODE_LOW_BALANCE = 'Credit balance is too low';
const OPENAI_QUOTA =
  'unexpected status 429 Too Many Requests: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}';

afterEach(() => resetCurrentAgentEnvForTests());

describe('provider credit exhaustion — matcher', () => {
  it.each([OPENROUTER_KEY_LIMIT, OPENROUTER_JSON_BODY, ANTHROPIC_LOW_BALANCE, CLAUDE_CODE_LOW_BALANCE, OPENAI_QUOTA])(
    'matches %j off the house rail, as a thrown error and as a completed reply',
    (text) => {
      expect(looksLikeByoProviderBilling(text, BYO_ENV)).toBe(true);
      expect(replyIsByoProviderBilling(text, BYO_ENV)).toBe(true);
    },
  );

  it('never matches on the house-proxy rail (a credits error there is ours, not the user\'s)', () => {
    for (const t of [OPENROUTER_KEY_LIMIT, ANTHROPIC_LOW_BALANCE, OPENAI_QUOTA]) {
      expect(looksLikeByoProviderBilling(t, HOUSE_ENV)).toBe(false);
    }
  });

  it.each([
    'Fixed the insufficient balance check in withdraw().',
    'Added a quota field to the plan and billing details page.',
    'The credit balance screen now shows the top-up button.',
    'Done. The export requires more memory on large repos.',
  ])('does not match an ordinary reply %j', (text) => {
    expect(replyIsByoProviderBilling(text, BYO_ENV)).toBe(false);
  });

  it('is length-guarded on the completed-reply path', () => {
    const long = `Here is what I found about billing:\n${'x'.repeat(700)}\n${OPENROUTER_KEY_LIMIT}`;
    expect(replyIsByoProviderBilling(long, BYO_ENV)).toBe(false);
  });
});

describe('failureBubble — thrown-error path', () => {
  it.each([
    [OPENROUTER_KEY_LIMIT, 'claude', BYO_ENV, 'OpenRouter'],
    [ANTHROPIC_LOW_BALANCE, 'claude', {}, 'Anthropic'],
    [OPENAI_QUOTA, 'codex', {}, 'OpenAI'],
  ])('%j → top-up/switch bubble naming the provider', (detail, agent, env, provider) => {
    const bubble = failureBubble({ detail, recentStderr: '', hadText: false, agent, env });
    expect(bubble).toBe(byoProviderBillingMessage(provider));
    expect(bubble).not.toBe(TURN_FAILURE_MESSAGE);
    expect(bubble).not.toBe(providerOutageMessage(agent));
    // Not a credential problem: never the re-auth / reconnect bubbles (those
    // are the only ones that trigger reportCredentialInvalid).
    expect(bubble).not.toBe(AUTH_FAILURE_MESSAGE);
    expect(bubble).not.toBe(ONE_M_CREDITS_MESSAGE);
  });

  it('wins over an outage line in the same stderr (never the outage bubble)', () => {
    const bubble = failureBubble({
      detail: 'prompt failed',
      recentStderr: `API Error: 503 upstream error, retrying\n${OPENROUTER_KEY_LIMIT}`,
      hadText: true,
      agent: 'claude',
      env: BYO_ENV,
    });
    expect(bubble).toBe(byoProviderBillingMessage('OpenRouter'));
  });
});

describe('completedReplyFailureBubble — completed-turn reply path', () => {
  it('swaps the raw provider text for the bubble', () => {
    expect(
      completedReplyFailureBubble({ finalText: `API Error: 402 ${OPENROUTER_KEY_LIMIT}`, agent: 'claude', env: BYO_ENV }),
    ).toBe(byoProviderBillingMessage('OpenRouter'));
    expect(completedReplyFailureBubble({ finalText: OPENROUTER_KEY_LIMIT, agent: 'claude', env: BYO_ENV })).toBe(
      byoProviderBillingMessage('OpenRouter'),
    );
  });
});

describe('default env = the CURRENT agent, not the deploy-time process env', () => {
  it('after a house → OpenRouter switch the bubble shows and names OpenRouter', () => {
    const saved = { url: process.env.ANTHROPIC_BASE_URL, tok: process.env.ANTHROPIC_AUTH_TOKEN };
    Object.assign(process.env, HOUSE_ENV); // frozen at the house deploy
    try {
      // What relaunchWith records when leaving the house rail for BYO OpenRouter.
      setCurrentAgentEnv({ ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1' });
      expect(failureBubble({ detail: OPENROUTER_KEY_LIMIT, recentStderr: '', hadText: false, agent: 'claude' })).toBe(
        byoProviderBillingMessage('OpenRouter'),
      );
      expect(completedReplyFailureBubble({ finalText: OPENROUTER_KEY_LIMIT, agent: 'claude' })).toBe(
        byoProviderBillingMessage('OpenRouter'),
      );
    } finally {
      if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved.url;
      if (saved.tok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = saved.tok;
    }
  });
});

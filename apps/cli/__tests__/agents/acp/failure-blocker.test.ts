/**
 * codeagent-gfip — every blocker bubble the CLI builds carries a TYPED tag on
 * its terminal output chunk, so the apps attach the escape-route buttons from
 * the kind instead of regex-matching the wording. The wording had already
 * drifted: the apps matched "reached your daily CodeAgent Cloud limit" while
 * `houseAgentLimitMessage` says "You’ve reached today’s agent usage limit", so
 * the CLI-built house-limit bubble never got its buttons.
 */
import { describe, expect, it, vi } from 'vitest';
import { toSessionBlocker } from '@codeam/shared';
import {
  AUTH_FAILURE_MESSAGE,
  CURSOR_UPGRADE_MESSAGE,
  TURN_FAILURE_MESSAGE,
  byoProviderBillingMessage,
  emptyReplyMessage,
  failureBlocker,
  houseAgentLimitMessage,
  providerOutageMessage,
  startupFailureMessage,
} from '../../../src/agents/acp/failure-messages';
import { AcpPublisher } from '../../../src/agents/acp/publisher';
import { StreamingState } from '../../../src/agents/acp/runner';

vi.mock('../../../src/services/pairing.service', () => ({
  fetchCurrentPluginAuthToken: vi.fn(),
  _postJsonAuthed: vi.fn(),
}));

describe('failureBlocker — the CLI recognises its own blocker bubbles', () => {
  it.each([
    [AUTH_FAILURE_MESSAGE, { kind: 'agent_auth_failed' }],
    [CURSOR_UPGRADE_MESSAGE, { kind: 'agent_plan_required', agentId: 'cursor' }],
    [houseAgentLimitMessage('403 daily ceiling — upgrade to Pro'), { kind: 'house_agent_limit' }],
    [houseAgentLimitMessage('403 ceiling reached'), { kind: 'house_agent_limit' }],
    [
      houseAgentLimitMessage('CodeAgent Cloud is temporarily unavailable'),
      { kind: 'house_agent_unavailable' },
    ],
    [
      byoProviderBillingMessage('OpenRouter'),
      { kind: 'provider_credits_exhausted', provider: 'OpenRouter' },
    ],
    [
      startupFailureMessage('codex', 'spawn failed', 'sqlite runtime error'),
      { kind: 'agent_startup_failed', agentId: 'codex' },
    ],
  ])('tags %#', (bubble, expected) => {
    const blocker = failureBlocker(bubble);
    expect(blocker).toEqual(expected);
    // …and the tag is valid on the wire contract the apps parse.
    expect(toSessionBlocker(blocker)).toEqual(expected);
  });

  it('leaves non-blocker bubbles untagged (retry, outage, empty reply, a normal reply)', () => {
    expect(failureBlocker(TURN_FAILURE_MESSAGE)).toBeUndefined();
    expect(failureBlocker(providerOutageMessage('claude'))).toBeUndefined();
    expect(failureBlocker(emptyReplyMessage('kimi'))).toBeUndefined();
    expect(failureBlocker('Your account has no credits left? Here is how billing works…')).toBeUndefined();
  });
});

describe('StreamingState.closeWithBubble — publishes the tag next to the bubble', () => {
  function harness() {
    const publisher = new AcpPublisher({
      sessionId: 'sess-1',
      pluginId: 'plugin-1',
      pluginAuthToken: 'tok-1',
      apiBaseUrl: 'https://api.example.test',
    });
    const publishOutput = vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
    vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
    return { streaming: new StreamingState(publisher), publishOutput };
  }

  it('a blocker bubble carries `blocker` on its terminal text chunk', async () => {
    const { streaming, publishOutput } = harness();
    await streaming.closeWithBubble(byoProviderBillingMessage('OpenRouter'));
    expect(publishOutput).toHaveBeenCalledWith({
      type: 'text',
      content: byoProviderBillingMessage('OpenRouter'),
      done: true,
      blocker: { kind: 'provider_credits_exhausted', provider: 'OpenRouter' },
    });
  });

  it('any other bubble is published exactly as before (no `blocker` key)', async () => {
    const { streaming, publishOutput } = harness();
    await streaming.closeWithBubble(TURN_FAILURE_MESSAGE);
    expect(publishOutput).toHaveBeenCalledWith({
      type: 'text',
      content: TURN_FAILURE_MESSAGE,
      done: true,
    });
  });
});

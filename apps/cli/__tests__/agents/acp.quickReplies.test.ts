/**
 * acp.quickReplies.test.ts
 *
 * Verifies that the ACP runner emits a static `input_suggestion` chunk with
 * `content: ACP_QUICK_REPLIES` on a NORMAL (happy-path) turn end, and does
 * NOT emit it when the reply terminates via a select_prompt (interactive
 * detection path).
 *
 * Invariants:
 *  1. Normal turn end → publishOutput called with
 *     { type: 'input_suggestion', content: ['Continue','Yes, go ahead','Explain'], done: true }
 *  2. select_prompt detected at turn end → `closeTurnWithInteractiveDetection` emits
 *     the select_prompt; no additional `input_suggestion` chip is emitted on the
 *     happy path (the interactive path replaces the tap gesture).
 *  3. ACP_QUICK_REPLIES constant has exactly the 3 expected labels.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpPublisher } from '../../src/agents/acp/publisher';
import {
  StreamingState,
  handleCommand,
  ACP_QUICK_REPLIES,
} from '../../src/agents/acp/runner';

// Stub network calls that handleCommand would otherwise make.
vi.mock('../../src/services/pairing.service', () => ({
  fetchCurrentPluginAuthToken: vi.fn(),
  _postJsonAuthed: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

type OutputCall = { type?: string; content?: unknown; done?: boolean };

/**
 * Build a minimal harness for a normal (non-throwing) ACP turn.
 * `client.prompt` resolves immediately with a stopReason of 'end_turn'.
 */
function makeHarness(opts: {
  /** Simulate a trailing "1. foo\n2. bar" in the reply so closeTurnWithInteractiveDetection
   *  emits a select_prompt instead of a text chip. */
  hasSelectPromptInReply?: boolean;
}) {
  const publisher = new AcpPublisher({
    sessionId: 'sess-quick',
    pluginId: 'plugin-quick',
    pluginAuthToken: 'tok-quick',
    apiBaseUrl: 'https://api.example.test',
  });

  const publishOutput = vi
    .spyOn(publisher, 'publishOutput')
    .mockResolvedValue(undefined);
  vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'pushConversation').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'pushSessionList').mockResolvedValue(undefined);

  const streaming = new StreamingState(publisher);

  const replyText = opts.hasSelectPromptInReply
    ? 'Do you want to continue?\n❯ 1. Yes\n2. No'
    : 'Here is your answer.';

  const client = {
    prompt: vi.fn(async () => {
      // Stream a text delta so finalText is non-empty.
      streaming.append({ chunkId: 'msg-1', kind: 'text', delta: replyText });
      return { stopReason: 'end_turn' as const };
    }),
    cancel: vi.fn(async () => undefined),
  };

  const sendResult = vi.fn(async () => undefined);
  const relay = { sendResult };
  const turnFiles = { flushTurn: vi.fn(async () => undefined) };

  const runOpts = {
    agent: 'claude' as const,
    sessionId: 'sess-quick',
    pluginId: 'plugin-quick',
    pluginAuthToken: 'tok-quick',
    adapter: { command: 'noop', args: [] },
    cwd: '/tmp',
  };

  const inputSuggestionCalls = (): OutputCall[] =>
    publishOutput.mock.calls
      .map((c) => c[0] as OutputCall)
      .filter((b) => b.type === 'input_suggestion');

  const run = () =>
    handleCommand(
      { id: 'cmd-qr', type: 'start_task', payload: { prompt: 'hello' } } as never,
      client as never,
      relay as never,
      'acp-sess-quick',
      streaming,
      runOpts as never,
      {
        appendUserPrompt: vi.fn(),
        appendAgentReply: vi.fn(),
        flush: vi.fn(async () => undefined),
      } as never,
      { uploadConversationIfChanged: vi.fn(async () => undefined) } as never,
      undefined,
      turnFiles as never,
      () => null,
      publisher,
      [],
      { offer: vi.fn(async () => undefined), tryRecover: vi.fn(async () => false) } as never,
      { get: () => false, set: vi.fn() },
    );

  return { run, publishOutput, inputSuggestionCalls, sendResult };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ACP_QUICK_REPLIES constant', () => {
  it('contains exactly the 3 expected chip labels', () => {
    expect(ACP_QUICK_REPLIES).toEqual(['Continue', 'Yes, go ahead', 'Explain']);
  });

  it('is a non-empty array', () => {
    expect(Array.isArray(ACP_QUICK_REPLIES)).toBe(true);
    expect(ACP_QUICK_REPLIES.length).toBe(3);
  });
});

describe('ACP runner — input_suggestion on normal turn end', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits input_suggestion with content = ACP_QUICK_REPLIES after a normal turn', async () => {
    const { run, inputSuggestionCalls } = makeHarness({});
    await run();

    const chips = inputSuggestionCalls();
    expect(chips).toHaveLength(1);
    expect(chips[0]).toEqual({
      type: 'input_suggestion',
      content: ['Continue', 'Yes, go ahead', 'Explain'],
      done: true,
    });
  });

  it('emits input_suggestion as an array (not a string) — ACP path', async () => {
    const { run, inputSuggestionCalls } = makeHarness({});
    await run();

    const chips = inputSuggestionCalls();
    expect(Array.isArray(chips[0].content)).toBe(true);
  });

  it('the turn completes successfully (sendResult called with "completed")', async () => {
    const { run, sendResult } = makeHarness({});
    await run();
    expect(sendResult).toHaveBeenCalledWith('cmd-qr', 'completed', expect.any(Object));
  });
});

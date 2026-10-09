/**
 * acp.quickReplies.test.ts
 *
 * Verifies that the ACP runner emits CONTEXT-RELEVANT `input_suggestion` chips
 * on a normal turn end (quickRepliesForTurn): a chip only when it is a complete
 * answer to where the turn stopped. Generic "Continue / Yes, go ahead / Explain"
 * after every turn burned FREE tasks on non-building turns (replays 2026-10-05,
 * shokhanahmadi61).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpPublisher } from '../../src/agents/acp/publisher';
import {
  StreamingState,
  handleCommand,
  quickRepliesForTurn,
} from '../../src/agents/acp/runner';

// Stub network calls that handleCommand would otherwise make.
vi.mock('../../src/services/pairing.service', () => ({
  postTurnEvent: vi.fn().mockResolvedValue(undefined),
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
  replyText?: string;
  stopReason?: string;
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

  const replyText =
    opts.replyText ??
    (opts.hasSelectPromptInReply ? 'Do you want to continue?\n❯ 1. Yes\n2. No' : 'Here is your answer.');

  const client = {
    prompt: vi.fn(async () => {
      // Stream a text delta so finalText is non-empty.
      streaming.append({ chunkId: 'msg-1', kind: 'text', delta: replyText });
      return { stopReason: opts.stopReason ?? 'end_turn' };
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
    );

  return { run, publishOutput, inputSuggestionCalls, sendResult };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('quickRepliesForTurn', () => {
  it('a reply ending in a yes/no question offers Yes / No', () => {
    expect(quickRepliesForTurn('I sketched the layout. Want me to build it?')).toEqual([
      'Yes, go ahead',
      'No',
    ]);
    expect(quickRepliesForTurn('Done with the plan.\n\n**Should I start now?**')).toEqual([
      'Yes, go ahead',
      'No',
    ]);
  });

  it('an open or multiple-choice question offers nothing (a Yes chip answers nothing)', () => {
    // The exact reply that ate a FREE task via "Continue" (shokhanahmadi61).
    expect(quickRepliesForTurn('1. Notes app\n2. Habit tracker\n3. Quiz game\n\nWhich one?')).toEqual([]);
    expect(quickRepliesForTurn("Which one? Or say 'pick one' and I'll build it.")).toEqual([]);
    expect(quickRepliesForTurn('Do you want the blue theme or the dark one?')).toEqual([]);
    expect(quickRepliesForTurn("What's your business name?")).toEqual([]);
  });

  it('a finished build or explanation offers nothing — no Continue / Explain', () => {
    expect(quickRepliesForTurn('Built the to-do app and opened the preview.')).toEqual([]);
  });

  it('a reply cut short offers Continue', () => {
    expect(quickRepliesForTurn('Halfway through the refactor', 'max_tokens')).toEqual(['Continue']);
    expect(quickRepliesForTurn('Still going', 'max_turn_requests')).toEqual(['Continue']);
  });
});

describe('ACP runner — input_suggestion on normal turn end', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits an EMPTY chip list after a turn that ends with a statement (clears stale chips)', async () => {
    const { run, inputSuggestionCalls } = makeHarness({});
    await run();

    const chips = inputSuggestionCalls();
    expect(chips).toHaveLength(1);
    expect(chips[0]).toEqual({ type: 'input_suggestion', content: [], done: true });
  });

  it('emits Yes / No when the reply ends with a yes/no question', async () => {
    const { run, inputSuggestionCalls } = makeHarness({ replyText: 'Want me to build it?' });
    await run();

    expect(inputSuggestionCalls()[0].content).toEqual(['Yes, go ahead', 'No']);
  });

  it('emits Continue when the turn was cut short', async () => {
    const { run, inputSuggestionCalls } = makeHarness({ stopReason: 'max_tokens' });
    await run();

    expect(inputSuggestionCalls()[0].content).toEqual(['Continue']);
  });

  it('the turn completes successfully (sendResult called with "completed")', async () => {
    const { run, sendResult } = makeHarness({});
    await run();
    expect(sendResult).toHaveBeenCalledWith('cmd-qr', 'completed', expect.any(Object));
  });
});

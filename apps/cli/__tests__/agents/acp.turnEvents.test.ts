/**
 * codeagent-wj4n — the ACP `start_task` path reports its funnel phases on
 * `POST /api/commands/turn-events` (the backend's `cli_turn` event), exactly
 * like the PTY `startTask` does. Every managed/cloud session is ACP, and this
 * path reported NOTHING: `cli_turn` had zero events, so a lost turn was
 * indistinguishable from a command the CLI never saw.
 *
 * Invariants: received → started → completed on success; `failed` carries a
 * CODE (never the agent's text); every event carries the relay commandId.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpPublisher } from '../../src/agents/acp/publisher';
import { StreamingState, handleCommand } from '../../src/agents/acp/runner';
import { postTurnEvent } from '../../src/services/pairing.service';

vi.mock('../../src/services/pairing.service', () => ({
  postTurnEvent: vi.fn().mockResolvedValue(undefined),
  fetchCurrentPluginAuthToken: vi.fn(),
  _postJsonAuthed: vi.fn(),
}));

const postTurnEventMock = vi.mocked(postTurnEvent);

function makeHarness(promptImpl: (streaming: StreamingState) => Promise<unknown>) {
  const publisher = new AcpPublisher({
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'tok-1',
    apiBaseUrl: 'https://api.example.test',
  });
  vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'pushConversation').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'pushSessionList').mockResolvedValue(undefined);
  const streaming = new StreamingState(publisher);
  const client = {
    prompt: vi.fn(async () => promptImpl(streaming)),
    cancel: vi.fn(async () => undefined),
  };
  const opts = {
    agent: 'claude' as const,
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'tok-1',
    adapter: { command: 'noop', args: [] },
    cwd: '/tmp',
  };
  const run = (payload: Record<string, unknown>) =>
    handleCommand(
      { id: 'cmd-turn-1', type: 'start_task', payload } as never,
      client as never,
      { sendResult: vi.fn(async () => undefined) } as never,
      'acp-sess-1',
      streaming,
      opts as never,
      {
        appendUserPrompt: vi.fn(),
        appendAgentReply: vi.fn(),
        flush: vi.fn(async () => undefined),
      } as never,
      { uploadConversationIfChanged: vi.fn(async () => undefined) } as never,
      undefined,
      { flushTurn: vi.fn(async () => undefined) } as never,
      () => null,
      publisher,
      [],
    );
  return { run };
}

const events = () =>
  postTurnEventMock.mock.calls.map((c) => ({ phase: c[0].phase, errorCode: c[0].errorCode }));

describe('ACP start_task — cli_turn funnel (codeagent-wj4n)', () => {
  beforeEach(() => {
    postTurnEventMock.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 }) as Response));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a successful turn reports received → started → completed with the relay commandId', async () => {
    const { run } = makeHarness(async (streaming) => {
      streaming.append({ chunkId: 'm1', kind: 'text', delta: 'All done — tests pass.' });
      return { stopReason: 'end_turn' };
    });
    await run({ prompt: 'run the tests' });
    expect(events()).toEqual([
      { phase: 'received', errorCode: undefined },
      { phase: 'started', errorCode: undefined },
      { phase: 'completed', errorCode: undefined },
    ]);
    for (const [arg] of postTurnEventMock.mock.calls) {
      expect(arg).toMatchObject({
        commandId: 'cmd-turn-1',
        pluginId: 'plugin-1',
        pluginAuthToken: 'tok-1',
        agentId: 'claude',
      });
    }
  });

  it('an empty prompt reports received → failed EMPTY_PROMPT (never started)', async () => {
    const { run } = makeHarness(async () => ({ stopReason: 'end_turn' }));
    await run({ prompt: '   ' });
    expect(events()).toEqual([
      { phase: 'received', errorCode: undefined },
      { phase: 'failed', errorCode: 'EMPTY_PROMPT' },
    ]);
  });

  it('a thrown 401 reports failed AUTH_FAILED — a code, never the agent text', async () => {
    const { run } = makeHarness(async () => {
      throw new Error('Internal error: Failed to authenticate. API Error: 401 Invalid authentication credentials');
    });
    await run({ prompt: 'hi' });
    expect(events()).toEqual([
      { phase: 'received', errorCode: undefined },
      { phase: 'started', errorCode: undefined },
      { phase: 'failed', errorCode: 'AUTH_FAILED' },
    ]);
  });

  it('an auth notice streamed as the completed reply reports failed AUTH_FAILED', async () => {
    const { run } = makeHarness(async (streaming) => {
      streaming.append({ chunkId: 'm1', kind: 'text', delta: 'Not logged in · Please run /login' });
      return { stopReason: 'end_turn' };
    });
    await run({ prompt: 'hi' });
    expect(events().at(-1)).toEqual({ phase: 'failed', errorCode: 'AUTH_FAILED' });
  });

  it('a generic failure with no streamed text reports failed TURN_ERROR', async () => {
    const { run } = makeHarness(async () => {
      throw new Error('socket hang up');
    });
    await run({ prompt: 'hi' });
    expect(events().at(-1)).toEqual({ phase: 'failed', errorCode: 'TURN_ERROR' });
  });
});

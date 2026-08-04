/**
 * Regression (codeagent-dtz7, 2026-08-04) — a turn that runs LONGER than the
 * backend's `COMMAND_TTL` (10 min) succeeds and streams its reply, but the
 * final `relay.sendResult(cmd.id, 'completed', …)` ACK 404s because the
 * `command:<id>` record has already expired. That POST-CLOSE ack failure must
 * NOT be caught and turned into the generic "The agent hit an error and
 * couldn't finish this turn" bubble — which `closeWithBubble` would use to
 * OVERWRITE the already-delivered reply (a FALSE failure on a succeeded turn,
 * confirmed live on Rafael's 18-min turn: `prompt ← ok` then `prompt failed:
 * HTTP 404` on the ack).
 *
 * Contract: when `sendResult` throws AFTER the turn has closed cleanly, the
 * streamed reply stays as the terminal frame and NO failure bubble is
 * published.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpPublisher } from '../../src/agents/acp/publisher';
import {
  StreamingState,
  handleCommand,
  TURN_FAILURE_MESSAGE,
} from '../../src/agents/acp/runner';

vi.mock('../../src/services/pairing.service', () => ({
  fetchCurrentPluginAuthToken: vi.fn(),
  _postJsonAuthed: vi.fn(),
}));

const REPLY = 'Here is the finished answer after a long agentic turn.';

type OutputCall = { type?: string; content?: string; done?: boolean };

/** A 404 shaped like the relay's `makeHttpError` output for an expired command. */
function make404(): Error & { statusCode: number } {
  const e = new Error('HTTP 404: {"success":false,"error":{"code":"NOT_FOUND"}}') as Error & {
    statusCode: number;
  };
  e.statusCode = 404;
  return e;
}

function makeHarness() {
  const publisher = new AcpPublisher({
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'tok-1',
    apiBaseUrl: 'https://api.example.test',
  });
  const publishOutput = vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'pushConversation').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'pushSessionList').mockResolvedValue(undefined);

  const streaming = new StreamingState(publisher);

  // A normal, successful turn: streams a reply, ends with end_turn.
  const client = {
    prompt: vi.fn(async () => {
      streaming.append({ chunkId: 'msg-1', kind: 'text', delta: REPLY });
      return { stopReason: 'end_turn' };
    }),
    cancel: vi.fn(async () => undefined),
  };

  // The command record has expired → the completion ACK 404s.
  const sendResult = vi.fn(async () => {
    throw make404();
  });
  const relay = { sendResult };
  const turnFiles = { flushTurn: vi.fn(async () => undefined) };

  const opts = {
    agent: 'claude' as const,
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'tok-1',
    adapter: { command: 'noop', args: [] },
    cwd: '/tmp',
  };

  const terminalTextFrames = (): OutputCall[] =>
    publishOutput.mock.calls
      .map((c) => c[0] as OutputCall)
      .filter((b) => b.type === 'text' && b.done === true);

  const run = () =>
    handleCommand(
      { id: 'cmd-1', type: 'start_task', payload: { prompt: 'do the big thing' } } as never,
      client as never,
      relay as never,
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
      turnFiles as never,
      () => null,
      publisher,
      [],
      { offer: vi.fn(async () => undefined), tryRecover: vi.fn(async () => false) } as never,
      { get: () => false, set: vi.fn() },
    );

  return { run, client, sendResult, terminalTextFrames };
}

describe('ACP start_task — post-close ack 404 must NOT clobber a delivered reply', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 }) as Response));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does NOT publish the generic TURN_FAILURE bubble when the completion ACK 404s', async () => {
    const { run, terminalTextFrames } = makeHarness();
    await run();

    const finals = terminalTextFrames();
    // No terminal frame may carry the "couldn't finish" bubble.
    expect(finals.some((f) => f.content === TURN_FAILURE_MESSAGE)).toBe(false);
  });

  it('attempted the completion ACK exactly once (and swallowed its 404)', async () => {
    const { run, sendResult } = makeHarness();
    await expect(run()).resolves.toBeUndefined(); // never rejects
    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(sendResult).toHaveBeenCalledWith('cmd-1', 'completed', expect.anything());
  });

  it('does NOT cancel the adapter turn (nothing is stuck — the turn succeeded)', async () => {
    const { run, client } = makeHarness();
    await run();
    expect(client.cancel).not.toHaveBeenCalled();
  });
});

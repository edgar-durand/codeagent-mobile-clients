/**
 * Regression — when the linked agent STREAMS an auth-failure notice as a
 * normal reply chunk and THEN `client.prompt(...)` throws the 401, the
 * actionable re-auth bubble must REPLACE the raw streamed text as the SINGLE
 * terminal chat frame — not append a second bubble below the raw error.
 *
 * The bug (diagnosed from a live codespace debug log, Claude w/ expired
 * credential):
 *   1. The agent streams "Failed to authenticate. API Error: 401 Invalid
 *      authentication credentials" as `agent_message_chunk` text deltas
 *      (a `{type:'text', done:false}` bubble on the chat pipe).
 *   2. `client.prompt(blocks)` then THROWS with the same 401 detail.
 *
 * Old catch path: `recoverFromFailedTurn` → `closeAll()` published the raw
 * streamed text as a `{type:'text', done:true}` frame — FINALISING it as its
 * own terminal bubble. The subsequent `publishOutput({type:'text', content:
 * bubble, done:true})` could no longer overwrite a finalised turn (mobile's
 * processChunk only mutates a tail still in `streaming` state), so it landed
 * as a SECOND bubble: the raw 401 stayed pinned ABOVE the actionable re-auth
 * message. Two `done:true` text frames, raw error visible.
 *
 * Fixed: the catch path CANCELS the stuck turn (no `closeAll`), then routes
 * the actionable bubble through `streaming.closeWithBubble(bubble)` — the
 * streamed bubble is still `streaming`, so the bubble overwrites it in place.
 * ONE terminal `done:true` text frame, carrying the actionable message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpPublisher } from '../../src/agents/acp/publisher';
import {
  StreamingState,
  handleCommand,
  AUTH_FAILURE_MESSAGE,
} from '../../src/agents/acp/runner';

// reportCredentialInvalid resolves a fresh token via this service on a 401;
// stub it so no network call is attempted for token refresh.
vi.mock('../../src/services/pairing.service', () => ({
  fetchCurrentPluginAuthToken: vi.fn(),
  _postJsonAuthed: vi.fn(),
}));

const RAW_401 = 'Failed to authenticate. API Error: 401 Invalid authentication credentials';

type OutputCall = { type?: string; content?: string; done?: boolean };

function makeHarness() {
  const publisher = new AcpPublisher({
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'tok-1',
    apiBaseUrl: 'https://api.example.test',
  });
  const publishOutput = vi
    .spyOn(publisher, 'publishOutput')
    .mockResolvedValue(undefined);
  vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'pushConversation').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'pushSessionList').mockResolvedValue(undefined);

  const streaming = new StreamingState(publisher);

  // `client.prompt` streams the raw 401 as a text delta (exactly what the
  // adapter forwarded) and THEN throws the 401 — the live-log shape.
  const client = {
    prompt: vi.fn(async () => {
      streaming.append({ chunkId: 'msg-1', kind: 'text', delta: RAW_401 });
      throw new Error(`Internal error: ${RAW_401}`);
    }),
    cancel: vi.fn(async () => undefined),
  };

  const sendResult = vi.fn(async () => undefined);
  const relay = { sendResult };

  const turnFiles = { flushTurn: vi.fn(async () => undefined) };
  const oneMRecovery = { offer: vi.fn(async () => undefined), tryRecover: vi.fn(async () => false) };

  const opts = {
    agent: 'claude' as const,
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'tok-1',
    adapter: { command: 'noop', args: [] },
    cwd: '/tmp',
  };

  // The terminal `{type:'text', done:true}` frames published to the chat pipe.
  const terminalTextFrames = (): OutputCall[] =>
    publishOutput.mock.calls
      .map((c) => c[0] as OutputCall)
      .filter((b) => b.type === 'text' && b.done === true);

  const run = () =>
    handleCommand(
      { id: 'cmd-1', type: 'start_task', payload: { prompt: 'hi' } } as never,
      client as never,
      relay as never,
      'acp-sess-1',
      [],
      streaming,
      opts as never,
      // AcpHistory + jsonlHistory + agentCaps are not load-bearing for the
      // auth-failure catch contract — fire-and-forget through the spied
      // publisher / no-op stubs.
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
      oneMRecovery as never,
    );

  return { run, client, sendResult, terminalTextFrames, publishOutput };
}

describe('ACP start_task — actionable auth bubble REPLACES the streamed raw 401', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // reportCredentialInvalid POSTs via global fetch — capture it, return 200.
    fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('publishes the AUTH_FAILURE_MESSAGE as the terminal reply — NOT the raw 401', async () => {
    const { run, terminalTextFrames } = makeHarness();
    await run();

    const finals = terminalTextFrames();
    // Exactly ONE terminal `done:true` text frame — two would mean the raw
    // streamed text was finalised separately and the bubble appended below it.
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toBe(AUTH_FAILURE_MESSAGE);

    // The raw 401 must NEVER be finalised as a terminal reply.
    expect(finals.some((f) => (f.content ?? '').includes('401 Invalid authentication credentials'))).toBe(
      false,
    );
  });

  it('cancels the stuck adapter turn (promptQueueing poison) on the failure', async () => {
    const { run, client } = makeHarness();
    await run();
    expect(client.cancel).toHaveBeenCalledTimes(1);
  });

  it('flags the LinkedAgent credential invalid (reportCredentialInvalid → POST)', async () => {
    const { run } = makeHarness();
    await run();
    // Allow the fire-and-forget reportCredentialInvalid microtask to settle.
    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).toHaveBeenCalled();
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => /\/credential-invalid$/.test(u))).toBe(true);
  });

  it('acks the relay command as failed with the 401 detail', async () => {
    const { run, sendResult } = makeHarness();
    await run();
    expect(sendResult).toHaveBeenCalledWith('cmd-1', 'failed', expect.any(Object));
  });
});

/**
 * Generic-partial-work guard — a NON-auth, NON-outage failure that already
 * streamed real assistant text must KEEP that partial reply as the terminal
 * frame (failureBubble → null). The fix must NOT clobber genuine partial work
 * with a bubble.
 */
describe('ACP start_task — generic failure with partial text keeps the partial reply', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 }) as Response));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('finalises the streamed partial text (closeAll) and publishes NO synthetic bubble', async () => {
    const PARTIAL = 'Here is the first half of my answer';
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

    const client = {
      prompt: vi.fn(async () => {
        streaming.append({ chunkId: 'msg-1', kind: 'text', delta: PARTIAL });
        throw new Error('stream aborted mid-turn'); // non-auth, non-outage
      }),
      cancel: vi.fn(async () => undefined),
    };

    await handleCommand(
      { id: 'cmd-2', type: 'start_task', payload: { prompt: 'hi' } } as never,
      client as never,
      { sendResult: vi.fn(async () => undefined) } as never,
      'acp-sess-1',
      [],
      streaming,
      {
        agent: 'claude',
        sessionId: 'sess-1',
        pluginId: 'plugin-1',
        pluginAuthToken: 'tok-1',
        adapter: { command: 'noop', args: [] },
        cwd: '/tmp',
      } as never,
      { appendUserPrompt: vi.fn(), appendAgentReply: vi.fn(), flush: vi.fn(async () => undefined) } as never,
      { uploadConversationIfChanged: vi.fn(async () => undefined) } as never,
      undefined,
      { flushTurn: vi.fn(async () => undefined) } as never,
      () => null,
      publisher,
      [],
      { offer: vi.fn(async () => undefined), tryRecover: vi.fn(async () => false) } as never,
    );

    const finals = publishOutput.mock.calls
      .map((c) => c[0] as OutputCall)
      .filter((b) => b.type === 'text' && b.done === true);
    // ONE terminal frame, carrying the genuine partial reply (not a bubble).
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toBe(PARTIAL);
  });
});

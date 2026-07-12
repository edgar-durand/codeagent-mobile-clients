import { describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../../../src/agents/acp/client';
import type { AcpClientOptions } from '../../../src/agents/acp/client';
import { StreamingState } from '../../../src/agents/acp/runner';
import { AcpPublisher } from '../../../src/agents/acp/publisher';
import { mapSessionUpdate } from '../../../src/agents/acp/mappers';
import type { SessionNotification } from '@agentclientprotocol/sdk';

/**
 * Recovery for the kimi "Session is closed" P0 (fix/kimi-acp-session-closed).
 *
 * kimi (`kimi acp`, ≥0.23) closes its ACP session between turns, so the NEXT
 * `session/prompt` on the same sessionId rejects INSTANTLY with
 * `-32603 … data.details:"Session is closed"`. AcpClient now transparently
 * re-establishes the session (`session/load` resume when the agent supports it,
 * else `session/new`) and retries the prompt ONCE. Live-verified on the box:
 * a running kimi adapter re-opens the closed session via `session/load`, keeps
 * the conversation context, and ≥3 turns then work. These tests lock in that
 * behaviour AND prove the happy path + unrelated errors are untouched.
 */

function makeClient(): AcpClient {
  const opts: AcpClientOptions = {
    adapter: {} as unknown as AcpClientOptions['adapter'],
    cwd: '/tmp/work',
    mcpServers: [],
    onSessionUpdate: () => undefined,
    onRequestPermission: (async () => ({
      outcome: { outcome: 'cancelled' },
    })) as unknown as AcpClientOptions['onRequestPermission'],
  };
  return new AcpClient(opts);
}

interface Internals {
  connection: {
    prompt: ReturnType<typeof vi.fn>;
    loadSession: ReturnType<typeof vi.fn>;
    newSession: ReturnType<typeof vi.fn>;
  } | null;
  sessionId: string | null;
  supportsLoadSession: boolean;
}

const SESSION_CLOSED = {
  code: -32603,
  message: 'Internal error',
  data: { details: 'Session is closed' },
};

describe('AcpClient — kimi "Session is closed" recovery', () => {
  it('re-establishes via session/load (resume) and retries the prompt once on close', async () => {
    const client = makeClient();
    const prompt = vi
      .fn()
      .mockRejectedValueOnce(SESSION_CLOSED) // 1st attempt: session was closed
      .mockResolvedValueOnce({ stopReason: 'end_turn' }); // retry succeeds
    const loadSession = vi.fn().mockResolvedValue(undefined);
    const newSession = vi.fn();
    const internals = client as unknown as Internals;
    internals.connection = { prompt, loadSession, newSession };
    internals.sessionId = 'sess-closed';
    internals.supportsLoadSession = true;

    const res = await client.prompt('hi again');

    expect(res).toEqual({ stopReason: 'end_turn' });
    // Resumed the SAME closed session id (context preserved), not a fresh one.
    expect(loadSession).toHaveBeenCalledTimes(1);
    expect(loadSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-closed', cwd: '/tmp/work' }),
    );
    expect(newSession).not.toHaveBeenCalled();
    // Exactly one retry — 2 total prompt sends.
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(internals.sessionId).toBe('sess-closed');
  });

  it('falls back to session/new when the agent cannot resume (no loadSession)', async () => {
    const client = makeClient();
    const prompt = vi
      .fn()
      .mockRejectedValueOnce(SESSION_CLOSED)
      .mockResolvedValueOnce({ stopReason: 'end_turn' });
    const loadSession = vi.fn();
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'sess-fresh' });
    const internals = client as unknown as Internals;
    internals.connection = { prompt, loadSession, newSession };
    internals.sessionId = 'sess-closed';
    internals.supportsLoadSession = false;

    const res = await client.prompt('hi again');

    expect(res).toEqual({ stopReason: 'end_turn' });
    expect(newSession).toHaveBeenCalledTimes(1);
    expect(loadSession).not.toHaveBeenCalled();
    // Active session id switched to the fresh one for the retry + future turns.
    expect(internals.sessionId).toBe('sess-fresh');
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('does NOT re-establish on the happy path (no close)', async () => {
    const client = makeClient();
    const prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    const loadSession = vi.fn();
    const newSession = vi.fn();
    const internals = client as unknown as Internals;
    internals.connection = { prompt, loadSession, newSession };
    internals.sessionId = 'sess-1';
    internals.supportsLoadSession = true;

    await client.prompt('hello');

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(loadSession).not.toHaveBeenCalled();
    expect(newSession).not.toHaveBeenCalled();
  });

  it('does NOT re-establish for an unrelated error (auth / other -32603) — it propagates', async () => {
    const client = makeClient();
    // Same -32603 code, but NOT a session-closed body — the recovery must not
    // misfire on the adapter's own transient errors.
    const authErr = {
      code: -32603,
      message: 'Internal error',
      data: { details: 'Invalid authentication credentials' },
    };
    const prompt = vi.fn().mockRejectedValue(authErr);
    const loadSession = vi.fn();
    const newSession = vi.fn();
    const internals = client as unknown as Internals;
    internals.connection = { prompt, loadSession, newSession };
    internals.sessionId = 'sess-1';
    internals.supportsLoadSession = true;

    await expect(client.prompt('hello')).rejects.toBe(authErr);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(loadSession).not.toHaveBeenCalled();
    expect(newSession).not.toHaveBeenCalled();
  });

  it('retries only ONCE — a second close on the retry propagates (no loop)', async () => {
    const client = makeClient();
    const prompt = vi.fn().mockRejectedValue(SESSION_CLOSED); // closes every time
    const loadSession = vi.fn().mockResolvedValue(undefined);
    const newSession = vi.fn();
    const internals = client as unknown as Internals;
    internals.connection = { prompt, loadSession, newSession };
    internals.sessionId = 'sess-closed';
    internals.supportsLoadSession = true;

    await expect(client.prompt('hi')).rejects.toBe(SESSION_CLOSED);
    // 1 original + 1 retry = 2; re-established exactly once.
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(loadSession).toHaveBeenCalledTimes(1);
  });
});

/**
 * Recovery-replay swallow (fix/kimi-recovery-replay-swallow).
 *
 * The P0: kimi 0.23.6's recovery `session/load` REPLAYS the ENTIRE prior
 * conversation as `session/update` notifications BEFORE it resolves (the
 * earlier "kimi emits no replay" assumption was wrong — proven on box
 * x55p7gv5qrr72vxpw). Those replayed `agent_message_chunk`s were published as
 * live chunks, so a recovered turn's reply got a PRIOR turn's text prepended
 * (the user saw "¡Hola! ¿En qué puedo ayudarte hoy?" glued in front of the real
 * answer). Fix: `reestablishSession` brackets the load with
 * `beginLoadReplay()/endLoadReplay()` — the SAME StreamingState guard the baton
 * uses — so the replay is swallowed and only the retried prompt's real reply is
 * published.
 */
describe('AcpClient — recovery session/load history replay is swallowed', () => {
  function makeStreaming(): {
    streaming: StreamingState;
    publishOutput: ReturnType<typeof vi.fn>;
  } {
    // Real publisher with its network methods spied out — no POST leaves the
    // process and StreamingState sees a correctly typed AcpPublisher (no casts).
    const publisher = new AcpPublisher({
      sessionId: 'sess-closed',
      pluginId: 'plugin-1',
      pluginAuthToken: 'tok-1',
      apiBaseUrl: 'https://api.example.test',
    });
    const publishOutput = vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
    vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
    return { streaming: new StreamingState(publisher), publishOutput };
  }

  /** Build a client whose onSessionUpdate feeds the real StreamingState exactly
   *  like the runner does, and whose replay bracket is wired to that state. */
  function makeClientWiredTo(streaming: StreamingState): AcpClient {
    const opts: AcpClientOptions = {
      adapter: {} as unknown as AcpClientOptions['adapter'],
      cwd: '/tmp/work',
      mcpServers: [],
      onSessionUpdate: (n) => {
        for (const d of mapSessionUpdate(n)) streaming.append(d);
      },
      onRequestPermission: (async () => ({
        outcome: { outcome: 'cancelled' },
      })) as unknown as AcpClientOptions['onRequestPermission'],
      beginLoadReplay: () => streaming.beginLoadReplay(),
      endLoadReplay: () => streaming.endLoadReplay(),
    };
    return new AcpClient(opts);
  }

  /** All `type:'text'` bodies published to the chat pipe across the whole flow. */
  function publishedTexts(publishOutput: ReturnType<typeof vi.fn>): string[] {
    return publishOutput.mock.calls
      .map((c) => c[0] as { type: string; content?: string })
      .filter((b) => b.type === 'text')
      .map((b) => b.content ?? '');
  }

  function agentMsgNotification(messageId: string, text: string): SessionNotification {
    return {
      sessionId: 'sess-closed',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text },
      },
    } as unknown as SessionNotification;
  }

  const PRIOR_TURN_REPLY = '¡Hola! ¿En qué puedo ayudarte hoy?';
  const NEW_TURN_REPLY = 'The build passes — all 42 tests are green.';

  it('drops the replayed prior-turn text and publishes ONLY the retried reply', async () => {
    const { streaming, publishOutput } = makeStreaming();
    // Model the adapter emitting a session/update: it flows through the same
    // map→append path the runner uses. The client toggles streaming's
    // loadReplayActive via its wired begin/endLoadReplay, so append gates it.
    const emit = (mid: string, text: string) => {
      for (const d of mapSessionUpdate(agentMsgNotification(mid, text))) streaming.append(d);
    };

    // loadSession replays the prior conversation as a session/update BEFORE it
    // resolves — this is the exact frame #40 leak from the live debug log.
    const loadSession = vi.fn().mockImplementation(async () => {
      emit('msg-turn-1', PRIOR_TURN_REPLY);
    });
    // 1st prompt: the session is closed → recovery. Retry: the agent streams the
    // REAL new reply live, then resolves.
    const prompt = vi
      .fn()
      .mockRejectedValueOnce(SESSION_CLOSED)
      .mockImplementationOnce(async () => {
        emit('msg-turn-2', NEW_TURN_REPLY);
        return { stopReason: 'end_turn' };
      });

    const client = makeClientWiredTo(streaming);
    const internals = client as unknown as Internals;
    internals.connection = { prompt, loadSession, newSession: vi.fn() };
    internals.sessionId = 'sess-closed';
    internals.supportsLoadSession = true;

    const res = await client.prompt('are the tests green?');
    expect(res).toEqual({ stopReason: 'end_turn' });

    const texts = publishedTexts(publishOutput);
    // The recovered turn's published stream carries ONLY the new reply…
    expect(texts.at(-1)).toBe(NEW_TURN_REPLY);
    // …and the replayed prior-turn text was NEVER published (not prepended, not
    // in any intermediate frame) — the whole point of the fix.
    expect(texts.join('|')).not.toContain(PRIOR_TURN_REPLY);
  });

  it('brackets the recovery loadSession with begin→load→end, in order', async () => {
    const order: string[] = [];
    const loadSession = vi.fn().mockImplementation(async () => {
      order.push('load');
    });
    const prompt = vi
      .fn()
      .mockRejectedValueOnce(SESSION_CLOSED)
      .mockResolvedValueOnce({ stopReason: 'end_turn' });
    const opts: AcpClientOptions = {
      adapter: {} as unknown as AcpClientOptions['adapter'],
      cwd: '/tmp/work',
      mcpServers: [],
      onSessionUpdate: () => undefined,
      onRequestPermission: (async () => ({
        outcome: { outcome: 'cancelled' },
      })) as unknown as AcpClientOptions['onRequestPermission'],
      beginLoadReplay: () => order.push('begin'),
      endLoadReplay: () => order.push('end'),
    };
    const client = new AcpClient(opts);
    const internals = client as unknown as Internals;
    internals.connection = { prompt, loadSession, newSession: vi.fn() };
    internals.sessionId = 'sess-closed';
    internals.supportsLoadSession = true;

    await client.prompt('hi again');
    expect(order).toEqual(['begin', 'load', 'end']);
  });

  it('clears the replay guard (endLoadReplay) even if the recovery loadSession throws', async () => {
    const endLoadReplay = vi.fn();
    const loadErr = new Error('load blew up');
    const loadSession = vi.fn().mockRejectedValue(loadErr);
    const prompt = vi.fn().mockRejectedValueOnce(SESSION_CLOSED);
    const opts: AcpClientOptions = {
      adapter: {} as unknown as AcpClientOptions['adapter'],
      cwd: '/tmp/work',
      mcpServers: [],
      onSessionUpdate: () => undefined,
      onRequestPermission: (async () => ({
        outcome: { outcome: 'cancelled' },
      })) as unknown as AcpClientOptions['onRequestPermission'],
      beginLoadReplay: () => undefined,
      endLoadReplay,
    };
    const client = new AcpClient(opts);
    const internals = client as unknown as Internals;
    internals.connection = { prompt, loadSession, newSession: vi.fn() };
    internals.sessionId = 'sess-closed';
    internals.supportsLoadSession = true;

    await expect(client.prompt('hi')).rejects.toBe(loadErr);
    // finally ran → streaming can't get wedged with the guard stuck ON.
    expect(endLoadReplay).toHaveBeenCalledTimes(1);
  });
});

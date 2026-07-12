import { describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../../../src/agents/acp/client';
import type { AcpClientOptions } from '../../../src/agents/acp/client';

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

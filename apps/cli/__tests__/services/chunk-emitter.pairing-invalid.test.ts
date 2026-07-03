/**
 * ChunkEmitter — pairing-invalid (401/403 fatal) semantics.
 *
 * 2026-06-28 incident: a CLI whose pairing had been invalidated
 * server-side kept POSTing agent output to /api/commands/output with a
 * dead X-Plugin-Auth-Token — 401 ×34, silently. The contract under
 * test:
 *
 *   - 401/403 first goes through the existing silent-refresh path
 *     (workflow-continuity invariant — never interrupt a recoverable
 *     session).
 *   - When the refresh says the pairing is GONE (reconnect 404/401/403),
 *     the emitter marks the pairing invalid ONCE: actionable stderr
 *     message, `dead: true` outcome (upstream disposes the pump), and
 *     NO further POSTs for this session.
 *   - Transient refresh failures (5xx / network) keep the old
 *     behavior: `dead: false`, next emit re-tries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChunkEmitter, _transport } from '../../src/services/output/chunk-emitter';

const isReconnect = (url: string): boolean => url.includes('/api/pairing/reconnect');
const isOutput = (url: string): boolean => url.includes('/api/commands/output');

function makeEmitter(): ChunkEmitter {
  return new ChunkEmitter({
    sessionId: 'sess-1',
    pluginId: 'plug-1',
    pluginAuthToken: 'tok-stale',
  });
}

describe('ChunkEmitter pairing-invalid (401/403 fatal)', () => {
  let postSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    postSpy = vi.spyOn(_transport, 'post');
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const outputCalls = (): number =>
    postSpy.mock.calls.filter((c: unknown[]) => isOutput(String(c[0]))).length;

  const stderrText = (): string => stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');

  it('401 + reconnect 404 (session gone) → dead:true with an actionable re-pair message', async () => {
    postSpy.mockImplementation(async (url: string) => {
      if (isReconnect(url)) return { statusCode: 404, body: 'SESSION_NOT_FOUND' };
      return { statusCode: 401, body: 'INVALID_PLUGIN_TOKEN' };
    });

    const outcome = await makeEmitter().send({ type: 'text', content: 'hi', done: false });

    expect(outcome.dead).toBe(true);
    expect(stderrText()).toContain('codeam pair');
  });

  it('after the fatal 401, subsequent sends short-circuit — no more POSTs, still dead', async () => {
    postSpy.mockImplementation(async (url: string) => {
      if (isReconnect(url)) return { statusCode: 404, body: 'SESSION_NOT_FOUND' };
      return { statusCode: 401, body: 'INVALID_PLUGIN_TOKEN' };
    });

    const emitter = makeEmitter();
    await emitter.send({ type: 'text', content: 'a', done: false });
    const postsAfterFatal = outputCalls();

    const second = await emitter.send({ type: 'text', content: 'b', done: false });
    const third = await emitter.send(
      { type: 'text', content: 'c', done: true },
      { critical: true },
    );

    expect(second.dead).toBe(true);
    expect(third.dead).toBe(true);
    expect(outputCalls()).toBe(postsAfterFatal); // no 401 spam
  });

  it('the re-pair message is written ONCE, not per send', async () => {
    postSpy.mockImplementation(async (url: string) => {
      if (isReconnect(url)) return { statusCode: 404, body: 'SESSION_NOT_FOUND' };
      return { statusCode: 401, body: 'INVALID_PLUGIN_TOKEN' };
    });

    const emitter = makeEmitter();
    await emitter.send({ type: 'text', content: 'a', done: false });
    await emitter.send({ type: 'text', content: 'b', done: false });
    await emitter.send({ type: 'text', content: 'c', done: false });

    const mentions = stderrText().split('codeam pair').length - 1;
    expect(mentions).toBe(1);
  });

  it('403 is treated like 401 — refresh attempted, fatal when the pairing is gone', async () => {
    postSpy.mockImplementation(async (url: string) => {
      if (isReconnect(url)) return { statusCode: 404, body: 'SESSION_NOT_FOUND' };
      return { statusCode: 403, body: 'FORBIDDEN' };
    });

    const outcome = await makeEmitter().send({ type: 'text', content: 'hi', done: false });
    expect(outcome.dead).toBe(true);
  });

  it('401 that persists AFTER a successful refresh → fatal (fresh token still rejected)', async () => {
    postSpy.mockImplementation(async (url: string) => {
      if (isReconnect(url)) {
        return {
          statusCode: 200,
          body: JSON.stringify({ data: { pluginAuthToken: 'tok-fresh' } }),
        };
      }
      return { statusCode: 401, body: 'INVALID_PLUGIN_TOKEN' };
    });

    const emitter = makeEmitter();
    const outcome = await emitter.send(
      { type: 'text', content: 'hi', done: true },
      { critical: true },
    );

    expect(outcome.dead).toBe(true);
    // one original attempt + exactly one post-refresh retry — bounded.
    expect(outputCalls()).toBe(2);
  });

  it('401 + TRANSIENT reconnect failure (5xx) stays non-fatal — next emit still posts', async () => {
    postSpy.mockImplementation(async (url: string) => {
      if (isReconnect(url)) return { statusCode: 503, body: 'upstream unavailable' };
      return { statusCode: 401, body: 'INVALID_PLUGIN_TOKEN' };
    });

    const emitter = makeEmitter();
    const first = await emitter.send({ type: 'text', content: 'a', done: false });
    expect(first.dead).toBe(false);

    const before = outputCalls();
    await emitter.send({ type: 'text', content: 'b', done: false });
    expect(outputCalls()).toBe(before + 1); // not latched
  });

  it('401 + successful refresh + 2xx retry keeps the session alive (regression guard)', async () => {
    let outputAttempts = 0;
    postSpy.mockImplementation(async (url: string, headers: Record<string, string>) => {
      if (isReconnect(url)) {
        return {
          statusCode: 200,
          body: JSON.stringify({ data: { pluginAuthToken: 'tok-fresh' } }),
        };
      }
      outputAttempts += 1;
      if (outputAttempts === 1) return { statusCode: 401, body: 'INVALID_PLUGIN_TOKEN' };
      expect(headers['X-Plugin-Auth-Token']).toBe('tok-fresh');
      return { statusCode: 200, body: '{}' };
    });

    const emitter = makeEmitter();
    const outcome = await emitter.send(
      { type: 'text', content: 'hi', done: true },
      { critical: true },
    );

    expect(outcome.dead).toBe(false);
    expect(outputAttempts).toBe(2);

    // and the emitter is NOT latched — later sends go through.
    const before = outputCalls();
    await emitter.send({ type: 'text', content: 'more', done: false });
    expect(outputCalls()).toBe(before + 1);
  });
});

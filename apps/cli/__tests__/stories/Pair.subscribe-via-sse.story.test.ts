/**
 * Story — Pair completion arrives via the existing SSE commands
 * channel as a `pair_completed` synthetic command, not via 5-min
 * polling.
 *
 * Why this test exists
 * --------------------
 * QA Android #285: `codeam pair` polled `/api/pairing/status?pluginId=X`
 * every 3-30 s with exponential backoff on failures. On Nabeel's flaky
 * wifi the backoff widened past the moment the mobile actually claimed
 * the code and the 5 min wall clock fired before any poll observed
 * the pair state. Polling is also forbidden product-wide
 * (memory: feedback_no_polling_anywhere).
 *
 * Resolution: backend's `pair()` service publishes a synthetic
 * `pair_completed` command on the existing commands channel
 * (`/api/commands/pending/stream?pluginId=X`). The CLI subscribes
 * pre-pair (no auth — the endpoint is keyed by pluginId only) and
 * receives the event the moment the pair lands. Reuses the SSE
 * connection the CLI is going to need anyway after pair; no new
 * endpoint.
 *
 * Expected behaviour
 * ------------------
 * - On a `pair_completed` event with the user-info payload, the
 *   subscriber calls `onPaired(info)` with sessionId / user info /
 *   pluginAuthToken and unsubscribes.
 * - If no event lands within the 5 min wall clock, the subscriber
 *   calls `onTimeout()` and unsubscribes.
 * - The returned stop function cancels both branches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  subscribeToPairCompletion,
  _pairCompletionTestSeam,
} from '../../src/services/pair-completion-subscriber';

describe('story: pair completion via SSE pair_completed event', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires onPaired with the user info when pair_completed lands on the stream', () => {
    const onPaired = vi.fn();
    const onTimeout = vi.fn();
    const stop = subscribeToPairCompletion('plugin-abc', onPaired, onTimeout);

    // Drive the test seam: emit the synthetic command the backend
    // would publish on /api/commands/pending/stream.
    _pairCompletionTestSeam.feedCommand({
      id: 'cmd-1',
      type: 'pair_completed',
      pluginId: 'plugin-abc',
      sessionId: 'session-xyz',
      payload: {
        sessionId: 'session-xyz',
        userId: 'user-1',
        userName: 'Nabeel',
        userEmail: 'nabeel@example.com',
        plan: 'FREE',
        pluginAuthToken: 'v1.abc123',
      },
    });

    expect(onPaired).toHaveBeenCalledWith({
      sessionId: 'session-xyz',
      userId: 'user-1',
      userName: 'Nabeel',
      userEmail: 'nabeel@example.com',
      plan: 'FREE',
      pluginAuthToken: 'v1.abc123',
    });
    expect(onTimeout).not.toHaveBeenCalled();
    stop();
  });

  it('ignores command types other than pair_completed', () => {
    const onPaired = vi.fn();
    const onTimeout = vi.fn();
    subscribeToPairCompletion('plugin-abc', onPaired, onTimeout);

    _pairCompletionTestSeam.feedCommand({
      id: 'cmd-1',
      type: 'start_task',
      pluginId: 'plugin-abc',
      sessionId: 'session-xyz',
      payload: { prompt: 'hello' },
    });

    expect(onPaired).not.toHaveBeenCalled();
  });

  it('fires onTimeout after 5 min if no event lands', () => {
    const onPaired = vi.fn();
    const onTimeout = vi.fn();
    subscribeToPairCompletion('plugin-abc', onPaired, onTimeout);

    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onPaired).not.toHaveBeenCalled();
  });

  it('the returned stop function cancels both branches', () => {
    const onPaired = vi.fn();
    const onTimeout = vi.fn();
    const stop = subscribeToPairCompletion('plugin-abc', onPaired, onTimeout);

    stop();

    // Subsequent events / timeouts must be no-ops after stop().
    _pairCompletionTestSeam.feedCommand({
      id: 'cmd-1',
      type: 'pair_completed',
      pluginId: 'plugin-abc',
      sessionId: 'session-xyz',
      payload: { sessionId: 'session-xyz' },
    });
    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(onPaired).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as pairing from '../src/services/pairing.service';

vi.mock('../src/services/pairing.service', () => ({
  _postJson: vi.fn().mockResolvedValue({ success: true }),
  _getJson: vi.fn().mockResolvedValue({ data: [] }),
}));

import { CommandRelayService } from '../src/services/command-relay.service';
import * as gitBranch from '../src/lib/git-branch';
import { AGENT_REGISTRY } from '@codeam/shared';

// Tests historically constructed CommandRelayService with 2 args; as
// of #56 the agentMeta is required. Reuse the canonical Claude entry
// from the shared registry so we're not redefining the metadata shape.
const META = AGENT_REGISTRY.claude;

describe('CommandRelayService', () => {
  const realRandom = Math.random;
  beforeEach(() => {
    vi.useFakeTimers();
    // Deterministic jitter (mid-range): exp * (0.9 + 0.5 * 0.2) = exp * 1.0
    Math.random = () => 0.5;
  });
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); Math.random = realRandom; });

  it('calls heartbeat on start', async () => {
    const onCmd = vi.fn();
    const relay = new CommandRelayService('plugin-1', onCmd, META);
    relay.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/plugin/heartbeat'),
      expect.objectContaining({ pluginId: 'plugin-1', online: true }),
    );
    relay.stop();
  });

  it('heartbeat stays turn-independent: syncs git ONCE at start, refreshes async on recurring ticks', async () => {
    // The 20 s beat must stay punctual even while a long agent tool
    // call hammers the event loop. A synchronous `git` spawn on the
    // recurring tick would couple the beat to git latency — so the
    // sync seam may fire only at start(), and every later refresh goes
    // through the non-blocking async seam. Regression for the
    // "LAST PING —" hang.
    const syncSeam = vi
      .spyOn(gitBranch._execSeam, 'exec')
      .mockReturnValue('main\n');
    const asyncSeam = vi
      .spyOn(gitBranch._execSeamAsync, 'exec')
      .mockResolvedValue('feature/x\n');

    const relay = new CommandRelayService('plugin-hb', vi.fn(), META);
    relay.start();
    await vi.advanceTimersByTimeAsync(10); // initial (sync-seeded) beat
    const syncCallsAfterStart = syncSeam.mock.calls.length;
    expect(syncCallsAfterStart).toBeGreaterThanOrEqual(1); // seeded once
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/plugin/heartbeat'),
      expect.objectContaining({ branch: 'main' }), // first beat = sync seed
    );

    await vi.advanceTimersByTimeAsync(20_000 * 3 + 100); // 3 recurring ticks

    // The sync seam is NEVER called again on the recurring hot path.
    expect(syncSeam.mock.calls.length).toBe(syncCallsAfterStart);
    // The async refresh drives the recurring branch updates instead.
    expect(asyncSeam).toHaveBeenCalled();
    // And the refreshed branch propagates onto a later heartbeat.
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/plugin/heartbeat'),
      expect.objectContaining({ branch: 'feature/x' }),
    );
    relay.stop();
  });

  it('polls for commands with idle backoff after empty responses', async () => {
    // After the idle-streak backoff landed, an idle CLI no longer
    // hits the API every 2 s — empty responses widen the delay
    // exponentially (capped) so a quiet CLI doesn't burn rate
    // limit / pgbouncer capacity. The polling fallback is still
    // active (this test runs with NODE_ENV=test so SSE is
    // disabled), it just paces itself when nothing is delivered.
    const onCmd = vi.fn();
    const relay = new CommandRelayService('plugin-1', onCmd, META);
    relay.start();
    await vi.advanceTimersByTimeAsync(10_100);
    expect(pairing._getJson).toHaveBeenCalledWith(
      expect.stringContaining('pending?pluginId=plugin-1'),
      // SEC crit1 (#8): poll now carries the X-Plugin-Poll-Secret header
      // (empty {} here — no persisted session for this synthetic pluginId).
      expect.any(Object),
    );
    // At least two polls in ~10 s of idle (initial + one backed-off
    // retry). The exact count drifts with jitter so we don't pin a
    // hard upper bound — we just verify the fallback is still
    // making forward progress.
    expect(vi.mocked(pairing._getJson).mock.calls.length).toBeGreaterThanOrEqual(2);
    relay.stop();
  });

  it('invokes onCommand callback when server returns commands', async () => {
    vi.mocked(pairing._getJson).mockResolvedValue({
      data: [{ id: 'cmd1', sessionId: 's1', type: 'start_task', payload: { prompt: 'hi' } }],
    });
    const onCmd = vi.fn();
    const relay = new CommandRelayService('plugin-1', onCmd, META);
    relay.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(onCmd).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cmd1', type: 'start_task' }),
    );
    relay.stop();
  });

  it('at-least-once: dedupes a redelivered command (runs once) and acks its id', async () => {
    // The backend now delivers non-destructively (peek) and redelivers until
    // acked — so the SAME command can arrive on two consecutive polls. It must
    // run exactly once, and we must POST /api/commands/ack to drain the queue.
    const dup = [{ id: 'cmd-dup', sessionId: 's1', type: 'start_task', payload: { prompt: 'hi' } }];
    vi.mocked(pairing._getJson).mockResolvedValue({ data: dup });
    const onCmd = vi.fn();
    const relay = new CommandRelayService('plugin-1', onCmd, META);
    relay.start();
    await vi.advanceTimersByTimeAsync(2100); // poll #1 delivers cmd-dup
    await vi.advanceTimersByTimeAsync(2100); // poll #2 REDELIVERS cmd-dup
    // Dispatched exactly once despite two deliveries.
    expect(onCmd).toHaveBeenCalledTimes(1);
    // Acked so the server removes it from the queue.
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/commands/ack'),
      expect.objectContaining({ pluginId: 'plugin-1', commandIds: ['cmd-dup'] }),
      expect.anything(),
    );
    relay.stop();
  });

  it('advertises at-least-once support via the X-Codeam-Cmd-Ack header on polls', async () => {
    vi.mocked(pairing._getJson).mockResolvedValue({ data: [] });
    const relay = new CommandRelayService('plugin-1', vi.fn(), META);
    relay.start();
    await vi.advanceTimersByTimeAsync(2100);
    // The poll passes the delivery headers (incl. the ack advertisement).
    expect(pairing._getJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/commands/pending'),
      expect.objectContaining({ 'X-Codeam-Cmd-Ack': '1' }),
    );
    relay.stop();
  });

  it('sendResult posts to /api/commands/result', async () => {
    const relay = new CommandRelayService('plugin-1', vi.fn(), META);
    await relay.sendResult('cmd1', 'completed', { output: 'done' });
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/commands/result'),
      { commandId: 'cmd1', status: 'completed', result: { output: 'done' } },
    );
  });

  it('stop sends offline heartbeat', async () => {
    const relay = new CommandRelayService('plugin-1', vi.fn(), META);
    relay.start();
    relay.stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/plugin/heartbeat'),
      expect.objectContaining({ online: false }),
    );
  });
});

describe('CommandRelayService pairing-invalid (401/403 fatal on /api/commands/result)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  const httpError = (statusCode: number): Error & { statusCode: number } =>
    Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

  const resultCalls = (): number =>
    vi
      .mocked(pairing._postJson)
      .mock.calls.filter((c) => String(c[0]).includes('/api/commands/result')).length;

  it('a 401 marks the pairing invalid: swallowed, actionable message, relay stopped, no further result posts', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const relay = new CommandRelayService('plugin-1', vi.fn(), META);
    relay.start();
    await vi.advanceTimersByTimeAsync(10);

    vi.mocked(pairing._postJson).mockRejectedValueOnce(httpError(401));
    // Fatal is swallowed — callers must not take their catch-and-repost path.
    await expect(relay.sendResult('cmd1', 'completed', {})).resolves.toBeUndefined();
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('codeam pair');

    const after = resultCalls();
    await relay.sendResult('cmd2', 'completed', {});
    await relay.sendResult('cmd3', 'failed', {});
    expect(resultCalls()).toBe(after); // latched — no 401 spam

    // relay stopped — no further heartbeats after the fatal.
    const heartbeats = (): number =>
      vi
        .mocked(pairing._postJson)
        .mock.calls.filter((c) => String(c[0]).includes('/api/plugin/heartbeat')).length;
    const beatsAtFatal = heartbeats();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeats()).toBe(beatsAtFatal);
  });

  it('a 403 is fatal too', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const relay = new CommandRelayService('plugin-1', vi.fn(), META);
    vi.mocked(pairing._postJson).mockRejectedValueOnce(httpError(403));
    await expect(relay.sendResult('cmd1', 'completed', {})).resolves.toBeUndefined();

    const after = resultCalls();
    await relay.sendResult('cmd2', 'completed', {});
    expect(resultCalls()).toBe(after);
  });

  it('non-auth errors keep rejecting and do NOT latch (transient path unchanged)', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const relay = new CommandRelayService('plugin-1', vi.fn(), META);

    vi.mocked(pairing._postJson).mockRejectedValueOnce(httpError(500));
    await expect(relay.sendResult('cmd1', 'completed', {})).rejects.toThrow('HTTP 500');

    // next result still posts — not latched.
    const before = resultCalls();
    await relay.sendResult('cmd2', 'completed', {});
    expect(resultCalls()).toBe(before + 1);
  });
});

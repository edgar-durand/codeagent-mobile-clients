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

  it('reportAgents POST body includes capabilities.squad === true', async () => {
    const relay = new CommandRelayService('plugin-cap', vi.fn(), META);
    relay.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/plugin/agents'),
      expect.objectContaining({
        pluginId: 'plugin-cap',
        agents: [expect.objectContaining({ id: 'claude' })],
        capabilities: { squad: true },
      }),
    );
    relay.stop();
  });

  it('setAgentMeta + reannounceAgents re-registers the switched agent and heartbeats it', async () => {
    // In-session agent switch: the SAME relay instance must re-report the
    // NEW agent (POST /api/plugin/agents) and heartbeat with the new id —
    // recreating the relay would drop the pending switch command's ack path.
    const relay = new CommandRelayService('plugin-sw', vi.fn(), META);
    relay.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/plugin/agents'),
      expect.objectContaining({
        pluginId: 'plugin-sw',
        agents: [expect.objectContaining({ id: 'claude' })],
        capabilities: { squad: true },
      }),
    );
    vi.mocked(pairing._postJson).mockClear();

    relay.setAgentMeta({ id: 'codex', name: 'codex', displayName: 'Codex CLI' } as never);
    relay.reannounceAgents();
    await vi.advanceTimersByTimeAsync(10);
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/plugin/agents'),
      expect.objectContaining({
        pluginId: 'plugin-sw',
        agents: [expect.objectContaining({ id: 'codex', name: 'Codex CLI' })],
        capabilities: { squad: true },
      }),
    );
    // The next heartbeat carries the new agent id too.
    await vi.advanceTimersByTimeAsync(20_000 + 100);
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/plugin/heartbeat'),
      expect.objectContaining({ agentId: 'codex' }),
    );
    relay.stop();
  });

  it('reannounceAgents keeps retrying via the agents timer until a POST lands', async () => {
    const relay = new CommandRelayService('plugin-rt', vi.fn(), META);
    relay.start();
    await vi.advanceTimersByTimeAsync(10);
    vi.mocked(pairing._postJson).mockClear();
    // First re-announce POST fails → agentsRegistered stays false → the 5 s
    // timer retries until one succeeds (at-least-once semantics).
    vi.mocked(pairing._postJson).mockRejectedValueOnce(new Error('network'));
    relay.reannounceAgents();
    await vi.advanceTimersByTimeAsync(10);
    const agentsPosts = () =>
      vi
        .mocked(pairing._postJson)
        .mock.calls.filter(([url]) => String(url).includes('/api/plugin/agents')).length;
    expect(agentsPosts()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(agentsPosts()).toBeGreaterThanOrEqual(2);
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

  it('replays an explicit poll secret as X-Plugin-Poll-Secret on /pending (host-agent control channel)', async () => {
    // The host-agent control channel has NO session row for its plugin, so it
    // passes the sealed control poll secret directly (5th ctor arg). It must be
    // sent verbatim as X-Plugin-Poll-Secret so /pending + /ack are PoP-authed —
    // closing the PLUGIN_SECRET_REQUIRED window on self_hosted_deploy.
    vi.mocked(pairing._getJson).mockResolvedValue({ data: [] });
    const relay = new CommandRelayService(
      'sh-control-plugin',
      vi.fn(),
      META,
      undefined,
      'raw-control-poll-secret',
    );
    relay.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(pairing._getJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/commands/pending'),
      expect.objectContaining({ 'X-Plugin-Poll-Secret': 'raw-control-poll-secret' }),
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

describe('CommandRelayService heartbeat rider (onHeartbeat)', () => {
  const realRandom = Math.random;
  beforeEach(() => {
    vi.useFakeTimers();
    Math.random = () => 0.5;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    Math.random = realRandom;
  });

  function heartbeatCalls(): number {
    return vi
      .mocked(pairing._postJson)
      .mock.calls.filter(([url]) => String(url).includes('/api/plugin/heartbeat')).length;
  }

  it('rides the SAME 20 s tick as the heartbeat — no second timer', async () => {
    const onHeartbeat = vi.fn();
    const relay = new CommandRelayService(
      'plugin-hb-rider',
      vi.fn(),
      META,
      undefined,
      undefined,
      onHeartbeat,
    );
    relay.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(onHeartbeat).toHaveBeenCalledTimes(1); // start()'s immediate beat
    const beatsAfterStart = heartbeatCalls();

    await vi.advanceTimersByTimeAsync(20_000 * 3 + 100);
    // Exactly one rider invocation per beat — never more, never fewer.
    expect(onHeartbeat.mock.calls.length).toBe(heartbeatCalls());
    expect(heartbeatCalls()).toBe(beatsAfterStart + 3);
    relay.stop();
  });

  it('flags the beats around a (re)connect, then settles to steady ticks', async () => {
    const onHeartbeat = vi.fn();
    const relay = new CommandRelayService(
      'plugin-hb-connect',
      vi.fn(),
      META,
      undefined,
      undefined,
      onHeartbeat,
    );
    relay.start();
    await vi.advanceTimersByTimeAsync(10);
    // Beat 1 = start()'s immediate beat, issued BEFORE any command channel
    // exists. Beat 2 = the first beat after the channel came up (the polling
    // fallback here, a 200 SSE stream in production) — both re-affirm.
    expect(onHeartbeat).toHaveBeenNthCalledWith(1, { firstAfterConnect: true });
    await vi.advanceTimersByTimeAsync(20_000 + 10);
    expect(onHeartbeat).toHaveBeenNthCalledWith(2, { firstAfterConnect: true });
    // From there on it's steady ticks — the rider's own throttle takes over.
    await vi.advanceTimersByTimeAsync(20_000 + 10);
    expect(onHeartbeat).toHaveBeenNthCalledWith(3, { firstAfterConnect: false });
    relay.stop();
  });

  it('a throwing rider never kills the beat', async () => {
    const onHeartbeat = vi.fn(() => {
      throw new Error('rider blew up');
    });
    const relay = new CommandRelayService(
      'plugin-hb-throw',
      vi.fn(),
      META,
      undefined,
      undefined,
      onHeartbeat,
    );
    relay.start();
    await vi.advanceTimersByTimeAsync(10);
    const before = heartbeatCalls();
    await vi.advanceTimersByTimeAsync(20_000 * 2 + 100);
    expect(heartbeatCalls()).toBe(before + 2);
    expect(onHeartbeat).toHaveBeenCalledTimes(3);
    relay.stop();
  });

  it('the beat stays punctual: the rider adds no sync git read and no awaited work', async () => {
    // Regression guard for CLAUDE.md "Heartbeat must stay punctual" — the
    // rider is fire-and-forget, so a POST that never resolves cannot stall
    // the next 20 s beat, and the sync git seam is still start()-only.
    const syncSeam = vi.spyOn(gitBranch._execSeam, 'exec').mockReturnValue('main\n');
    vi.spyOn(gitBranch._execSeamAsync, 'exec').mockResolvedValue('main\n');
    const onHeartbeat = vi.fn(() => {
      void new Promise(() => {}); // a POST that never settles
    });
    const relay = new CommandRelayService(
      'plugin-hb-punctual',
      vi.fn(),
      META,
      undefined,
      undefined,
      onHeartbeat,
    );
    relay.start();
    await vi.advanceTimersByTimeAsync(10);
    const syncCallsAfterStart = syncSeam.mock.calls.length;
    const before = heartbeatCalls();

    await vi.advanceTimersByTimeAsync(20_000 * 3 + 100);
    expect(heartbeatCalls()).toBe(before + 3); // still punctual
    expect(syncSeam.mock.calls.length).toBe(syncCallsAfterStart); // no new sync I/O
    relay.stop();
  });

  it('relays without a rider are byte-for-byte unchanged', async () => {
    const relay = new CommandRelayService('plugin-hb-none', vi.fn(), META);
    relay.start();
    await vi.advanceTimersByTimeAsync(20_000 + 100);
    expect(heartbeatCalls()).toBe(2);
    relay.stop();
  });
});

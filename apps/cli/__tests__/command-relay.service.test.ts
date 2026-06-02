import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as pairing from '../src/services/pairing.service';

vi.mock('../src/services/pairing.service', () => ({
  _postJson: vi.fn().mockResolvedValue({ success: true }),
  _getJson: vi.fn().mockResolvedValue({ data: [] }),
}));

import { CommandRelayService } from '../src/services/command-relay.service';
import { AGENT_REGISTRY } from '@codeagent/shared';

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

  it('skips redelivered command ids from the pending queue', async () => {
    const cmd = { id: 'cmd1', sessionId: 's1', type: 'start_task', payload: { prompt: 'hi' } };
    vi.mocked(pairing._getJson).mockResolvedValue({ data: [cmd, cmd] });
    const onCmd = vi.fn();
    const relay = new CommandRelayService('plugin-1', onCmd, META);
    relay.start();

    await vi.advanceTimersByTimeAsync(10);
    expect(onCmd).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2100);
    expect(vi.mocked(pairing._getJson).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onCmd).toHaveBeenCalledTimes(1);
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

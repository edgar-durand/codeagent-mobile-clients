import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as pairing from '../src/services/pairing.service';

vi.mock('../src/services/pairing.service', () => ({
  _postJson: vi.fn().mockResolvedValue({ success: true }),
  _getJson: vi.fn().mockResolvedValue({ data: [] }),
}));

import { CommandRelayService } from '../src/services/command-relay.service';

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
    const relay = new CommandRelayService('plugin-1', onCmd);
    relay.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/plugin/heartbeat'),
      expect.objectContaining({ pluginId: 'plugin-1', online: true }),
    );
    relay.stop();
  });

  it('polls for commands every 2 seconds', async () => {
    const onCmd = vi.fn();
    const relay = new CommandRelayService('plugin-1', onCmd);
    relay.start();
    await vi.advanceTimersByTimeAsync(6100);
    // Initial poll + 3 interval polls
    expect(pairing._getJson).toHaveBeenCalledWith(
      expect.stringContaining('pending?pluginId=plugin-1'),
    );
    expect(vi.mocked(pairing._getJson).mock.calls.length).toBeGreaterThanOrEqual(3);
    relay.stop();
  });

  it('invokes onCommand callback when server returns commands', async () => {
    vi.mocked(pairing._getJson).mockResolvedValue({
      data: [{ id: 'cmd1', sessionId: 's1', type: 'start_task', payload: { prompt: 'hi' } }],
    });
    const onCmd = vi.fn();
    const relay = new CommandRelayService('plugin-1', onCmd);
    relay.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(onCmd).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cmd1', type: 'start_task' }),
    );
    relay.stop();
  });

  it('sendResult posts to /api/commands/result', async () => {
    const relay = new CommandRelayService('plugin-1', vi.fn());
    await relay.sendResult('cmd1', 'completed', { output: 'done' });
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/commands/result'),
      { commandId: 'cmd1', status: 'completed', result: { output: 'done' } },
    );
  });

  it('stop sends offline heartbeat', async () => {
    const relay = new CommandRelayService('plugin-1', vi.fn());
    relay.start();
    relay.stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/plugin/heartbeat'),
      expect.objectContaining({ online: false }),
    );
  });
});

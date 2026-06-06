import { describe, expect, it, vi } from 'vitest';
import {
  createAckTrackingRelay,
  createAcpTerminalHandlers,
} from '../../src/agents/acp/runner';
import type { CommandRelayService } from '../../src/services/command-relay.service';

describe('ACP runner terminal relay', () => {
  it('publishes terminal data and exit events through the legacy output pipe', () => {
    const publishOutput = vi.fn().mockResolvedValue(undefined);
    const handlers = createAcpTerminalHandlers({ publishOutput });

    handlers.onData({ sessionId: 'term-1', data: 'hello\r\n' });
    handlers.onExit({ sessionId: 'term-1', exitCode: 7 });

    expect(publishOutput).toHaveBeenNthCalledWith(1, {
      type: 'terminal_data',
      terminalSessionId: 'term-1',
      data: 'hello\r\n',
      done: false,
    });
    expect(publishOutput).toHaveBeenNthCalledWith(2, {
      type: 'terminal_exit',
      terminalSessionId: 'term-1',
      exitCode: 7,
      done: true,
    });
  });
});

describe('ACP runner ack tracking relay', () => {
  function makeRelay() {
    const sendResult = vi.fn().mockResolvedValue(undefined);
    return {
      relay: { sendResult } as unknown as CommandRelayService,
      sendResult,
    };
  }

  it('marks the command acked when a delegated handler sends its own result', async () => {
    const { relay, sendResult } = makeRelay();
    const tracker = createAckTrackingRelay(relay, 'cmd-1');

    await tracker.relay.sendResult('cmd-1', 'completed', { ok: true });

    expect(tracker.wasAcked()).toBe(true);
    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(sendResult).toHaveBeenCalledWith('cmd-1', 'completed', { ok: true });
  });

  it('does not mark other command ids acked', async () => {
    const { relay } = makeRelay();
    const tracker = createAckTrackingRelay(relay, 'cmd-1');

    await tracker.relay.sendResult('cmd-2', 'completed', { ok: true });

    expect(tracker.wasAcked()).toBe(false);
  });

  it('prevents the fallback ack from clobbering a delegated handler result', async () => {
    const { relay, sendResult } = makeRelay();
    const tracker = createAckTrackingRelay(relay, 'cmd-1');

    await tracker.relay.sendResult('cmd-1', 'completed', { ok: true });
    if (!tracker.wasAcked()) {
      await relay.sendResult('cmd-1', 'completed', {});
    }

    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(sendResult).toHaveBeenCalledWith('cmd-1', 'completed', { ok: true });
  });

  it('lets the fallback ack fire only when the delegated handler stayed silent', async () => {
    const { relay, sendResult } = makeRelay();
    const tracker = createAckTrackingRelay(relay, 'cmd-1');

    if (!tracker.wasAcked()) {
      await relay.sendResult('cmd-1', 'completed', {});
    }

    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(sendResult).toHaveBeenCalledWith('cmd-1', 'completed', {});
  });
});

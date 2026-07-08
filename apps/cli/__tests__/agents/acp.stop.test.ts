/**
 * Regression — the mobile Stop button sends `stop_task` (aliased to
 * `escape_key`) over the relay. `stopTaskH` is the ACP handler for both:
 * it MUST cancel the agent's in-flight turn (ACP `session/cancel`), flush
 * any half-streamed reply via `streaming.closeAll()`, and ack the command
 * exactly once — otherwise the backend keeps it "pending" and mobile's
 * auto-refresh retries forever while the agent looks stuck.
 *
 * `stopTaskH` itself isn't exported (it's a private entry in the command
 * dispatch table), so this test drives it the same way the real runner
 * does: through the exported `ACP_COMMAND_HANDLERS` map.
 */

import { describe, expect, it, vi } from 'vitest';
import { ACP_COMMAND_HANDLERS, type AcpCommandContext } from '../../src/agents/acp/command-handlers';

function makeCtx(cancelImpl?: () => Promise<void>) {
  const order: string[] = [];
  const client = {
    cancel: vi.fn(async () => {
      if (cancelImpl) await cancelImpl();
      order.push('cancel');
    }),
  };
  const streaming = {
    closeAll: vi.fn(async () => {
      order.push('closeAll');
    }),
  };
  const relay = {
    sendResult: vi.fn(async () => {
      order.push('sendResult');
    }),
  };
  const cmd = { id: 'cmd-1', sessionId: 'sess-1', type: 'stop_task', payload: {} };
  // Partial mock at the test boundary — stopTaskH only reads
  // cmd/client/relay/streaming off the context.
  const ctx = { cmd, client, relay, streaming } as unknown as AcpCommandContext;
  return { ctx, client, streaming, relay, order };
}

describe('stopTaskH (ACP_COMMAND_HANDLERS.stop_task)', () => {
  it('cancels the in-flight turn, closes streaming, and acks completed exactly once', async () => {
    const { ctx, client, streaming, relay, order } = makeCtx();

    await ACP_COMMAND_HANDLERS.stop_task(ctx);

    expect(client.cancel).toHaveBeenCalledTimes(1);
    expect(streaming.closeAll).toHaveBeenCalledTimes(1);
    expect(relay.sendResult).toHaveBeenCalledTimes(1);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', {});
    expect(order).toEqual(['cancel', 'closeAll', 'sendResult']);
  });

  it('escape_key aliases the SAME handler as stop_task', () => {
    expect(ACP_COMMAND_HANDLERS.escape_key).toBe(ACP_COMMAND_HANDLERS.stop_task);
  });

  it('acks failed (without flushing streaming) when cancel throws — best-effort, does not hang the command', async () => {
    const { ctx, client, streaming, relay } = makeCtx(async () => {
      throw new Error('adapter gone');
    });

    await expect(ACP_COMMAND_HANDLERS.stop_task(ctx)).resolves.toBeUndefined();

    expect(client.cancel).toHaveBeenCalledTimes(1);
    expect(streaming.closeAll).not.toHaveBeenCalled();
    expect(relay.sendResult).toHaveBeenCalledTimes(1);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'failed', {
      error: 'adapter gone',
    });
  });
});

/**
 * Regression — a turn that fails (idle-timeout watchdog / adapter error)
 * must CANCEL the adapter's still-running turn before flushing, or the
 * next prompt queues behind the dead turn forever (`promptQueueing`) and
 * the session is poisoned ("agent stops responding, every later message
 * sits on Thinking…"). recoverFromFailedTurn encodes that contract.
 */

import { describe, expect, it, vi } from 'vitest';
import { recoverFromFailedTurn } from '../../src/agents/acp/runner';

function mocks(cancelImpl?: () => Promise<void>) {
  const order: string[] = [];
  const client = {
    cancel: vi.fn(async () => {
      order.push('cancel');
      if (cancelImpl) await cancelImpl();
    }),
  };
  const streaming = {
    closeAll: vi.fn(async () => {
      order.push('closeAll');
    }),
  };
  // The helper only touches .cancel() / .closeAll(); cast through unknown
  // so the test doesn't have to stub the entire class surface.
  return { client, streaming, order };
}

describe('recoverFromFailedTurn', () => {
  it('cancels the stuck turn BEFORE flushing the chat', async () => {
    const { client, streaming, order } = mocks();
    await recoverFromFailedTurn(client as never, streaming as never);
    expect(client.cancel).toHaveBeenCalledTimes(1);
    expect(streaming.closeAll).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['cancel', 'closeAll']);
  });

  it('still flushes the chat when cancel throws (best-effort, dead adapter)', async () => {
    const { client, streaming, order } = mocks(async () => {
      throw new Error('adapter gone');
    });
    await expect(
      recoverFromFailedTurn(client as never, streaming as never),
    ).resolves.toBeUndefined();
    expect(client.cancel).toHaveBeenCalledTimes(1);
    expect(streaming.closeAll).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['cancel', 'closeAll']);
  });
});

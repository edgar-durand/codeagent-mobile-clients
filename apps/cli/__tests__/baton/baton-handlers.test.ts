import { describe, it, expect, vi } from 'vitest';
import { handlers, type HandlerContext } from '../../src/commands/start/handlers';
import type { RemoteCommand } from '../../src/services/command-relay.service';

function ctx(baton: unknown) {
  return {
    baton,
    relay: { sendResult: vi.fn(async () => {}) },
  } as unknown as HandlerContext;
}

const cmd = (type: string) => ({ id: 'c1', sessionId: 's1', type, payload: {} }) as RemoteCommand;

describe('baton command handlers', () => {
  it('take_control drives BatonController.takeControl and acks completed', async () => {
    const baton = {
      takeControl: vi.fn(async () => {}),
      handback: vi.fn(async () => {}),
      state: 'MOBILE_DRIVE',
    };
    const c = ctx(baton);
    await handlers.take_control(c, cmd('take_control'), {} as never);
    expect(baton.takeControl).toHaveBeenCalledTimes(1);
    expect(c.relay.sendResult).toHaveBeenCalledWith('c1', 'completed', expect.anything());
  });

  it('handback drives BatonController.handback and acks completed', async () => {
    const baton = {
      takeControl: vi.fn(async () => {}),
      handback: vi.fn(async () => {}),
      state: 'LOCAL_DRIVE',
    };
    const c = ctx(baton);
    await handlers.handback(c, cmd('handback'), {} as never);
    expect(baton.handback).toHaveBeenCalledTimes(1);
    expect(c.relay.sendResult).toHaveBeenCalledWith('c1', 'completed', expect.anything());
  });

  it('acks failed with NO_BATON when the session has no baton', async () => {
    const c = ctx(undefined);
    await handlers.take_control(c, cmd('take_control'), {} as never);
    expect(c.relay.sendResult).toHaveBeenCalledWith('c1', 'failed', { code: 'NO_BATON' });
  });

  it('acks failed with BATON_SWITCH_FAILED when takeControl rejects', async () => {
    const baton = {
      takeControl: vi.fn(async () => {
        throw new Error('switch blew up');
      }),
      handback: vi.fn(async () => {}),
      state: 'LOCAL_DRIVE',
    };
    const c = ctx(baton);
    await handlers.take_control(c, cmd('take_control'), {} as never);
    expect(c.relay.sendResult).toHaveBeenCalledWith('c1', 'failed', {
      code: 'BATON_SWITCH_FAILED',
    });
  });
});

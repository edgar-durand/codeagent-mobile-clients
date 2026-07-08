import { describe, it, expect, vi } from 'vitest';
import { buildBaton, makeOnCommand } from '../../src/baton/wire-baton';
import type { RemoteCommand } from '../../src/services/command-relay.service';
import { isLocalSession } from '../../src/baton/gate';

describe('buildBaton composition', () => {
  it('routes take_control to the controller and other commands to the active driver dispatcher', async () => {
    const takeControl = vi.fn(async () => {});
    const dispatchActive = vi.fn(async () => {});
    const { onCommand } = buildBaton.forTest({
      controller: { takeControl, handback: vi.fn(), state: 'LOCAL_DRIVE' } as never,
      dispatchActive,
    });
    await onCommand({
      id: 'c1',
      sessionId: 's',
      type: 'take_control',
      payload: {},
    } as RemoteCommand);
    expect(takeControl).toHaveBeenCalledTimes(1);
    await onCommand({ id: 'c2', sessionId: 's', type: 'start_task', payload: {} } as RemoteCommand);
    expect(dispatchActive).toHaveBeenCalledTimes(1);
  });

  it('dispatchActive delegates a non-baton command to the ACTIVE driver dispatch', async () => {
    // Mirror the exact wiring runBatonSession uses:
    //   dispatchActive = (cmd) => controller.activeSessionDriver.dispatch(cmd)
    const dispatch = vi.fn(async (_cmd: RemoteCommand) => {});
    const controller = {
      takeControl: vi.fn(),
      handback: vi.fn(),
      state: 'MOBILE_DRIVE' as const,
      activeSessionDriver: { dispatch },
    };
    const dispatchActive = (cmd: RemoteCommand): Promise<void> =>
      controller.activeSessionDriver.dispatch(cmd);
    const { onCommand } = buildBaton.forTest({ controller: controller as never, dispatchActive });
    const cmd = { id: 'c9', sessionId: 's', type: 'start_task', payload: {} } as RemoteCommand;
    await onCommand(cmd);
    expect(dispatch).toHaveBeenCalledWith(cmd);
    expect(controller.takeControl).not.toHaveBeenCalled();
    expect(controller.handback).not.toHaveBeenCalled();
  });

  it('routes handback to the controller (not the active driver dispatcher)', async () => {
    const handback = vi.fn(async () => {});
    const dispatchActive = vi.fn(async () => {});
    const { onCommand } = buildBaton.forTest({
      controller: { takeControl: vi.fn(), handback, state: 'MOBILE_DRIVE' } as never,
      dispatchActive,
    });
    await onCommand({ id: 'c3', sessionId: 's', type: 'handback', payload: {} } as RemoteCommand);
    expect(handback).toHaveBeenCalledTimes(1);
    expect(dispatchActive).not.toHaveBeenCalled();
  });

  it('acks failed with BATON_SWITCH_FAILED when takeControl throws', async () => {
    const takeControl = vi.fn(async () => {
      throw new Error('mobile start blew up');
    });
    const dispatchActive = vi.fn(async () => {});
    const ack = vi.fn(async () => {});
    const onCommand = makeOnCommand({
      controller: { takeControl, handback: vi.fn(), state: 'LOCAL_DRIVE' } as never,
      dispatchActive,
      ack,
    });
    await onCommand({
      id: 'c4',
      sessionId: 's',
      type: 'take_control',
      payload: {},
    } as RemoteCommand);
    expect(ack).toHaveBeenCalledWith(
      'c4',
      'failed',
      expect.objectContaining({ code: 'BATON_SWITCH_FAILED' }),
    );
    expect(dispatchActive).not.toHaveBeenCalled();
  });

  it('acks failed with BATON_SWITCH_FAILED when handback throws', async () => {
    const handback = vi.fn(async () => {
      throw new Error('local start blew up');
    });
    const dispatchActive = vi.fn(async () => {});
    const ack = vi.fn(async () => {});
    const onCommand = makeOnCommand({
      controller: { takeControl: vi.fn(), handback, state: 'MOBILE_DRIVE' } as never,
      dispatchActive,
      ack,
    });
    await onCommand({ id: 'c5', sessionId: 's', type: 'handback', payload: {} } as RemoteCommand);
    expect(ack).toHaveBeenCalledWith(
      'c5',
      'failed',
      expect.objectContaining({ code: 'BATON_SWITCH_FAILED' }),
    );
    expect(dispatchActive).not.toHaveBeenCalled();
  });
});

describe('cloud/self-hosted regression (gate)', () => {
  it('cloud/self-hosted never enter the baton (gate is false)', () => {
    expect(isLocalSession({ CODESPACES: 'true' })).toBe(false);
    expect(isLocalSession({ CODEAM_AUTO_APPROVE: '1' })).toBe(false);
  });
});

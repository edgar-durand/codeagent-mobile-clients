/**
 * Edgar 2026-08-10: keep the Mac/Linux/Windows machine awake while a LOCAL
 * session runs so an idle laptop can't freeze the process and drop the paired
 * mobile app. The per-OS argv lives on the OS strategy (tested in os/strategy);
 * these lock the SERVICE lifecycle: gate (local + opt-out + unsupported OS),
 * best-effort spawn, and a disposer that releases the assertion.
 */
import { describe, it, expect, vi } from 'vitest';
import { keepDeviceAwake } from '../../src/services/keep-awake';

const CMD = { cmd: 'caffeinate', args: ['-i', '-s', '-w', '1'] };

function fakeChild() {
  return { pid: 4242, killed: false, once: vi.fn(), unref: vi.fn(), kill: vi.fn() };
}

describe('keepDeviceAwake', () => {
  it('no-ops for a NON-local session (codespace/self-hosted — not the user laptop)', () => {
    const spawnFn = vi.fn();
    const dispose = keepDeviceAwake({ isLocal: false, command: CMD, spawnFn: spawnFn as never });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });

  it('no-ops when opted out via CODEAM_NO_KEEP_AWAKE=1', () => {
    const spawnFn = vi.fn();
    keepDeviceAwake({ isLocal: true, env: { CODEAM_NO_KEEP_AWAKE: '1' } as never, command: CMD, spawnFn: spawnFn as never });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('no-ops on an unsupported OS (command === null)', () => {
    const spawnFn = vi.fn();
    keepDeviceAwake({ isLocal: true, env: {} as never, command: null, spawnFn: spawnFn as never });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns the assertion holder for a local session and the disposer kills it', () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const dispose = keepDeviceAwake({ isLocal: true, env: {} as never, command: CMD, spawnFn: spawnFn as never });
    expect(spawnFn).toHaveBeenCalledWith('caffeinate', ['-i', '-s', '-w', '1'], expect.objectContaining({ detached: true }));
    expect(child.unref).toHaveBeenCalled();
    dispose();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // idempotent — a second dispose is a no-op, not a double-kill.
    dispose();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('is best-effort — a spawn that throws never propagates', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('ENOENT caffeinate');
    });
    expect(() =>
      keepDeviceAwake({ isLocal: true, env: {} as never, command: CMD, spawnFn: spawnFn as never })(),
    ).not.toThrow();
  });
});

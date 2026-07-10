import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { CoderabbitRuntimeStrategy } from '../../../src/agents/coderabbit/runtime';

// Capture the fake child so the test can assert it was killed.
let lastProc: (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }) | null =
  null;
const spawnMock = vi.fn(() => {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  // Deliberately NEVER emit 'close' — models a review wedged on the
  // ide.coderabbit.ai WebSocket (the 2026-07-10 stuck-session incident).
  lastProc = proc;
  return proc;
});

vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...(a as [])) }));

// Fake OS so the binary "resolves" and buildLaunch is a passthrough.
const fakeOs = {
  findInPath: () => '/usr/bin/coderabbit',
  buildLaunch: (cmd: string, args: string[]) => ({ cmd, args }),
} as unknown as ConstructorParameters<typeof CoderabbitRuntimeStrategy>[0];

describe('CoderabbitRuntimeStrategy.runOneShot — hung-review timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastProc = null;
    spawnMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('kills the process and resolves with exit 124 when the review never exits', async () => {
    const r = new CoderabbitRuntimeStrategy(fakeOs);
    const p = r.runOneShot({ structured: false });

    // Past the 5-min ceiling (+ the 2 s SIGKILL grace).
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 2_100);
    const out = await p;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(out.exitCode).toBe(124);
    expect(out.rawStderr).toContain('timed out');
    expect(lastProc).not.toBeNull();
    // SIGTERM then SIGKILL (process never closed on its own).
    expect(lastProc!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(lastProc!.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('resolves normally (no kill) when the process closes before the timeout', async () => {
    const r = new CoderabbitRuntimeStrategy(fakeOs);
    const p = r.runOneShot({ structured: false });
    // Let the spawn + listeners attach.
    await vi.advanceTimersByTimeAsync(0);
    lastProc!.stdout.emit('data', Buffer.from('all good\n'));
    lastProc!.emit('close', 0);
    const out = await p;

    expect(out.exitCode).toBe(0);
    expect(lastProc!.kill).not.toHaveBeenCalled();
  });
});

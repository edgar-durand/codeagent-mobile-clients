import { describe, it, expect, vi } from 'vitest';
import { ensureSharedServer, _daemonSeam } from '../../src/beads/dolt-daemon';

/**
 * Fake adapter: `bd dolt status` reports running/not-running; `bd dolt start`
 * succeeds or fails. After a successful start, status flips to running so the
 * re-probe sees it (mirrors real bd behavior).
 */
function fakeAdapter(opts: { initiallyUp: boolean; startOk?: boolean }) {
  let up = opts.initiallyUp;
  const startOk = opts.startOk ?? true;
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'dolt' && args[1] === 'status') {
      return {
        code: 0,
        stdout: up
          ? 'Dolt server: running\n  PID:  34731\n  Port: 3308\n  Mode: shared server'
          : 'Dolt server: not running\n  Expected port: 3308',
        stderr: '',
      };
    }
    if (args[0] === 'dolt' && args[1] === 'start') {
      if (startOk) up = true;
      return {
        code: startOk ? 0 : 1,
        stdout: startOk ? 'Dolt server started (PID 34731, port 3308)' : '',
        stderr: startOk ? '' : 'failed to start',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  return { run } as any;
}

describe('_daemonSeam.isRunning', () => {
  it('true for a running status block', () => {
    expect(_daemonSeam.isRunning('Dolt server: running\n  PID:  1\n  Port: 3308')).toBe(true);
  });
  it('false for a not-running status block', () => {
    expect(_daemonSeam.isRunning('Dolt server: not running\n  Expected port: 3308')).toBe(false);
  });
});

describe('ensureSharedServer', () => {
  it('reuses a running server (no start spawned)', async () => {
    const a = fakeAdapter({ initiallyUp: true });
    const r = await ensureSharedServer(a);
    expect(r).toEqual({ up: true, started: false });
    expect(a.run).not.toHaveBeenCalledWith(expect.arrayContaining(['dolt', 'start']));
  });

  it('starts detached when down, then re-probes up', async () => {
    const a = fakeAdapter({ initiallyUp: false, startOk: true });
    const r = await ensureSharedServer(a);
    expect(r).toEqual({ up: true, started: true });
    expect(a.run).toHaveBeenCalledWith(['dolt', 'start']);
  });

  it('non-fatal when start fails', async () => {
    const a = fakeAdapter({ initiallyUp: false, startOk: false });
    const r = await ensureSharedServer(a);
    expect(r.up).toBe(false);
  });
});

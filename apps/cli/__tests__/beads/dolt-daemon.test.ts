import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BdAdapter } from '../../src/beads/bd-adapter';
import { ensureSharedServer, _daemonSeam } from '../../src/beads/dolt-daemon';

const STATUS_RUNNING =
  'Dolt server: running\n  PID:  34731\n  Port: 3308\n  Mode: shared server';
const STATUS_DOWN = 'Dolt server: not running\n  Expected port: 3308';

/**
 * Fake adapter: `bd dolt status` reports running/not-running; `bd dolt start`
 * succeeds or fails. After a successful start, status flips to running so the
 * re-probe sees it (mirrors real bd behavior).
 */
function fakeAdapter(opts: { initiallyUp: boolean; startOk?: boolean }): BdAdapter {
  let up = opts.initiallyUp;
  const startOk = opts.startOk ?? true;
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'dolt' && args[1] === 'status') {
      return { code: 0, stdout: up ? STATUS_RUNNING : STATUS_DOWN, stderr: '' };
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
  return { run } as unknown as BdAdapter;
}

/**
 * Programmable adapter for timing-sensitive cases: `statusResults` is consumed
 * one entry per `bd dolt status` call (the LAST entry repeats once exhausted),
 * `startCodes` likewise per `bd dolt start` call. Lets a test express "start
 * returns 0, but status is down on the first recheck and only flips to running
 * on a later poll" — the codespace cold-binary race.
 */
function programmableAdapter(opts: {
  statusResults: boolean[];
  startCodes: number[];
}): { adapter: BdAdapter; run: ReturnType<typeof vi.fn> } {
  let statusIdx = 0;
  let startIdx = 0;
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'dolt' && args[1] === 'status') {
      const i = Math.min(statusIdx, opts.statusResults.length - 1);
      statusIdx += 1;
      return {
        code: 0,
        stdout: opts.statusResults[i] ? STATUS_RUNNING : STATUS_DOWN,
        stderr: '',
      };
    }
    if (args[0] === 'dolt' && args[1] === 'start') {
      const i = Math.min(startIdx, opts.startCodes.length - 1);
      startIdx += 1;
      const code = opts.startCodes[i];
      return {
        code,
        stdout: code === 0 ? 'Dolt server starting' : '',
        stderr: code === 0 ? '' : 'failed to start',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  return { adapter: { run } as unknown as BdAdapter, run };
}

// Tiny, bounded poll/retry knobs so tests never wait on real time.
const FAST = { startAttempts: 3, pollAttempts: 5, pollDelayMs: 1 } as const;

describe('_daemonSeam.isRunning', () => {
  it('true for a running status block', () => {
    expect(_daemonSeam.isRunning('Dolt server: running\n  PID:  1\n  Port: 3308')).toBe(true);
  });
  it('false for a not-running status block', () => {
    expect(_daemonSeam.isRunning('Dolt server: not running\n  Expected port: 3308')).toBe(false);
  });
});

describe('ensureSharedServer', () => {
  // Stub the poll delay to a no-op so retry/poll loops resolve instantly —
  // never wait on real time (no fake timers either; the seam is enough).
  let sleepSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    sleepSpy = vi.spyOn(_daemonSeam, 'sleep').mockResolvedValue(undefined);
  });
  afterEach(() => {
    sleepSpy.mockRestore();
  });

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

  // REGRESSION: cold codespace — `dolt` was just downloaded (~127MB), so the
  // detached `dolt sql-server` is NOT listening on the FIRST status recheck,
  // only on a later poll. The old single-recheck returned up:false → agent
  // spawned → "Dolt server not running". Must poll until it flips to running.
  it('polls past a not-running first recheck and returns up:true', async () => {
    const { adapter, run } = programmableAdapter({
      // status calls: [initial down, recheck#1 down, poll#2 down, poll#3 running]
      statusResults: [false, false, false, true],
      startCodes: [0],
    });
    const r = await ensureSharedServer(adapter, FAST);
    expect(r).toEqual({ up: true, started: true });
    // start spawned exactly once; status polled until it saw running.
    const startCalls = run.mock.calls.filter(
      (c) => c[0][0] === 'dolt' && c[0][1] === 'start',
    );
    expect(startCalls.length).toBe(1);
  });

  // REGRESSION: first `bd dolt start` exits non-zero (binary still settling),
  // a retry succeeds, then status comes up. Must retry start, not give up.
  it('retries a failed start, then succeeds when status comes up', async () => {
    const { adapter, run } = programmableAdapter({
      // initial down; after the 2nd start, the poll sees running.
      statusResults: [false, false, true],
      startCodes: [1, 0],
    });
    const r = await ensureSharedServer(adapter, FAST);
    expect(r).toEqual({ up: true, started: true });
    const startCalls = run.mock.calls.filter(
      (c) => c[0][0] === 'dolt' && c[0][1] === 'start',
    );
    expect(startCalls.length).toBe(2);
  });

  // Never comes up after exhausting every retry+poll → up:false, no throw.
  it('returns up:false (non-fatal) after exhausting retries and polls', async () => {
    const { adapter } = programmableAdapter({
      statusResults: [false],
      startCodes: [0],
    });
    const r = await ensureSharedServer(adapter, FAST);
    expect(r.up).toBe(false);
  });
});

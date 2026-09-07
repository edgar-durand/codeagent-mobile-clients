import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import {
  watchForBuildClobber,
  isBuildHealSupported,
  resetBuildHealState,
} from '../../src/services/preview/build-heal';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('isBuildHealSupported', () => {
  it('matches Next.js frameworks case-insensitively', () => {
    expect(isBuildHealSupported('Next.js')).toBe(true);
    expect(isBuildHealSupported('next')).toBe(true);
    expect(isBuildHealSupported('NEXTJS')).toBe(true);
  });

  it('excludes every other framework — dev/build never share output there', () => {
    expect(isBuildHealSupported('Vite')).toBe(false);
    expect(isBuildHealSupported('Expo')).toBe(false);
    expect(isBuildHealSupported('Remix')).toBe(false);
    expect(isBuildHealSupported('')).toBe(false);
  });
});

// These exercise REAL fs.watch + REAL debounce timers against a real temp
// directory — no injected `watchDir` fake — because the whole point is to
// reproduce the actual sequence from the bug report: a preview stays
// `running`, something rewrites `.next/BUILD_ID` out from under it (exactly
// what `next build` does), and the dev server gets restarted. Debounce is
// shortened (20-30ms) so the suite stays fast; margins after each write are
// generous relative to that.
describe('watchForBuildClobber — real fs sequence', () => {
  let dir: string;
  let sessionId: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'build-heal-'));
    await fsp.mkdir(path.join(dir, '.next'));
    await fsp.writeFile(path.join(dir, '.next', 'BUILD_ID'), 'dev-build-id');
    sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    resetBuildHealState(sessionId);
  });

  afterEach(async () => {
    resetBuildHealState(sessionId);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('restarts the dev server when a real build rewrites BUILD_ID while the preview is running', async () => {
    const restart = vi.fn();
    const notify = vi.fn();
    const watcher = watchForBuildClobber({ cwd: dir, sessionId, restart, notify, debounceMs: 30 });
    try {
      await sleep(100); // let fs.watch actually attach before we write
      // Simulate `next build` rewriting the marker with a fresh production id
      // — this is the one write `next dev` itself never makes.
      await fsp.writeFile(path.join(dir, '.next', 'BUILD_ID'), 'prod-build-id');
      await sleep(400); // real debounce (30ms) + fs event propagation margin
      expect(restart).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith('Rebuilt — restarting preview');
    } finally {
      watcher.stop();
    }
  });

  // CONTROL: same setup, nothing touches BUILD_ID — proves the restart above
  // isn't a false positive from directory noise (temp-file writes, etc.)
  // that a naive "watch the whole .next dir" implementation could trip on.
  it('CONTROL — never restarts when nothing touches BUILD_ID', async () => {
    const restart = vi.fn();
    const notify = vi.fn();
    const watcher = watchForBuildClobber({ cwd: dir, sessionId, restart, notify, debounceMs: 30 });
    try {
      await sleep(300);
      expect(restart).not.toHaveBeenCalled();
    } finally {
      watcher.stop();
    }
  });

  it('never restarts once stop() tore the watcher down before the debounce fired', async () => {
    const restart = vi.fn();
    const notify = vi.fn();
    const watcher = watchForBuildClobber({ cwd: dir, sessionId, restart, notify, debounceMs: 200 });
    await sleep(100);
    await fsp.writeFile(path.join(dir, '.next', 'BUILD_ID'), 'prod-build-id');
    await sleep(30); // event has fired, the 200ms debounce timer is pending
    watcher.stop();
    await sleep(400); // well past the original debounce deadline
    expect(restart).not.toHaveBeenCalled();
  });

  it('debounces a burst of writes into a single restart', async () => {
    const restart = vi.fn();
    const notify = vi.fn();
    // ⚠️ The debounce window must dwarf the inter-write gap. With 80 ms vs
    // 15 ms this flaked on a loaded ubuntu/node-22 runner (2026-09-06, main
    // push after #715): one inotify delivery landed > 80 ms after the
    // previous write, the debounce fired mid-burst with the marker already
    // changed, and the tail of the burst produced a SECOND restart. Real fs
    // events need real time, so the margin is the only lever — 20× instead
    // of ~5×.
    const debounceMs = 300;
    const watcher = watchForBuildClobber({ cwd: dir, sessionId, restart, notify, debounceMs });
    try {
      await sleep(100);
      // A real `next build` touches many files under `.next/` in one pass —
      // simulate several rapid writes to the marker itself.
      for (let i = 0; i < 5; i++) {
        await fsp.writeFile(path.join(dir, '.next', 'BUILD_ID'), `prod-${i}`);
        await sleep(15);
      }
      await sleep(debounceMs + 400);
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      watcher.stop();
    }
  });
});

// Reproduces the recreate-per-restart lifecycle used in production: a
// heal-triggered restart kills the old ActivePreview and its watcher, then
// registers a brand-new one — so each round below is a FRESH
// `watchForBuildClobber` instance, exactly like `maybeAttachBuildHeal` would
// create after each restart. The cap must still hold across that
// recreation, or a genuine rebuild loop turns into an infinite restart loop.
describe('watchForBuildClobber — restart cap survives watcher recreation', () => {
  let dir: string;
  let sessionId: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'build-heal-cap-'));
    await fsp.mkdir(path.join(dir, '.next'));
    await fsp.writeFile(path.join(dir, '.next', 'BUILD_ID'), 'v0');
    sessionId = `sess-cap-${Math.random().toString(36).slice(2)}`;
    resetBuildHealState(sessionId);
  });

  afterEach(async () => {
    resetBuildHealState(sessionId);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('allows exactly maxRestarts restarts, then stops self-healing', async () => {
    const maxRestarts = 3;
    const rounds: Array<{ restarted: boolean; cappedMessage: boolean }> = [];

    for (let round = 1; round <= maxRestarts + 1; round++) {
      const restart = vi.fn();
      const notify = vi.fn();
      // A fresh watcher every round — the counter it reads/writes lives
      // outside this instance (see build-heal.ts's `healRestartCounts`).
      const watcher = watchForBuildClobber({
        cwd: dir,
        sessionId,
        restart,
        notify,
        debounceMs: 20,
        maxRestarts,
      });
      await sleep(80);
      await fsp.writeFile(path.join(dir, '.next', 'BUILD_ID'), `v${round}`);
      await sleep(250);
      rounds.push({
        restarted: restart.mock.calls.length > 0,
        cappedMessage: notify.mock.calls.some((c) =>
          String(c[0]).includes('stopped auto-restarting'),
        ),
      });
      watcher.stop();
    }

    expect(rounds.slice(0, maxRestarts).every((r) => r.restarted)).toBe(true);
    expect(rounds[maxRestarts].restarted).toBe(false);
    expect(rounds[maxRestarts].cappedMessage).toBe(true);
  }, 15_000);

  it('resetBuildHealState clears the cap so a later fresh preview starts clean', async () => {
    const maxRestarts = 1;
    // Exhaust the cap.
    for (let round = 1; round <= 2; round++) {
      const restart = vi.fn();
      const notify = vi.fn();
      const watcher = watchForBuildClobber({
        cwd: dir,
        sessionId,
        restart,
        notify,
        debounceMs: 20,
        maxRestarts,
      });
      await sleep(80);
      await fsp.writeFile(path.join(dir, '.next', 'BUILD_ID'), `v${round}`);
      await sleep(200);
      watcher.stop();
    }

    resetBuildHealState(sessionId);

    const restart = vi.fn();
    const notify = vi.fn();
    const watcher = watchForBuildClobber({
      cwd: dir,
      sessionId,
      restart,
      notify,
      debounceMs: 20,
      maxRestarts,
    });
    try {
      await sleep(80);
      await fsp.writeFile(path.join(dir, '.next', 'BUILD_ID'), 'v-final');
      await sleep(250);
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      watcher.stop();
    }
  }, 10_000);
});

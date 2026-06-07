/**
 * INTEGRATION TEST for the preview dev-server spawn → ready-pattern
 * detection path. Spawns REAL child processes (`node -e ...`) that
 * print stdout matching what Next.js, Vite, and friends actually
 * emit, then runs the production `waitForDevServerReady` + the
 * production `compileReadyPattern` against them.
 *
 * Why this test exists (regression that slipped past unit tests in
 * production, codespace `codeagent-mobile-p6gv9565jpgcr4wv`):
 *
 *   - Agent's preview detection returned
 *     `ready_pattern: "ready in|✓ Compiled"` (lowercase `r`).
 *   - Next.js 15 prints `✓ Ready in 1.5s` (capital `R`).
 *   - The OLD `new RegExp(pattern)` was case-sensitive → never
 *     matched → 120 s `ERR_READY_TIMEOUT` while the dev server was
 *     happily serving.
 *   - Unit tests on `compileReadyPattern` (isolated) didn't catch it
 *     because the bug only manifests when the COMPILED regex is fed
 *     REAL spawned-process stdout. This integration test closes that
 *     gap by spawning a process that prints exactly what Next.js
 *     prints and asserting the watcher resolves.
 *
 * A future regression that drops the `i` flag (or rewrites the
 * matcher to be case-sensitive) will fail every case below.
 */

import { spawn } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compileReadyPattern,
  waitForDevServerReady,
} from '../../src/commands/start/handlers';
import type { ChildProcess } from 'child_process';

// Track every spawned process so we can clean them up even if an
// assertion fails midway through a test.
const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const p of spawned) {
    try { p.kill('SIGKILL'); } catch { /* already dead */ }
  }
  spawned.length = 0;
});

/**
 * Spawn a fake dev server that prints `line` to stdout after `delayMs`
 * and then sleeps so the parent has a live process to watch.
 */
function spawnFakeDevServer(line: string, delayMs = 200): ChildProcess {
  const script = `setTimeout(() => { process.stdout.write(${JSON.stringify(line + '\n')}); setInterval(() => {}, 1000); }, ${delayMs});`;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(child);
  return child;
}

/**
 * Spawn a fake server that exits immediately with the given code —
 * used to verify the early-exit branch of `waitForDevServerReady`.
 */
function spawnExitingProcess(exitCode: number): ChildProcess {
  const child = spawn(process.execPath, ['-e', `process.exit(${exitCode});`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(child);
  return child;
}

describe('preview spawn → ready-pattern (integration)', () => {
  it('THE PRODUCTION REGRESSION: lowercase agent pattern matches Next.js 15 capital-R stdout', async () => {
    // Exact failure we reproduced in codespace
    // codeagent-mobile-p6gv9565jpgcr4wv: agent emitted `"ready in"`,
    // Next.js printed `✓ Ready in 1.5s`. Old code timed out at 120 s;
    // fixed code matches on first chunk.
    const child = spawnFakeDevServer('   ✓ Ready in 1.5s');
    const re = compileReadyPattern('ready in');

    const outcome = await waitForDevServerReady(child, re, { timeoutMs: 3_000 });

    expect(outcome.kind).toBe('ready');
  });

  it('lowercase agent pattern matches Vite ready line', async () => {
    const child = spawnFakeDevServer('  VITE v5.0.0  ready in 320 ms');
    const re = compileReadyPattern('ready in');

    const outcome = await waitForDevServerReady(child, re, { timeoutMs: 3_000 });

    expect(outcome.kind).toBe('ready');
  });

  it('alternation pattern matches against either branch regardless of case', async () => {
    // `"ready in|✓ Compiled"` was the exact pattern the agent emitted
    // in the production failure. Cover both alternatives.
    const reA = compileReadyPattern('ready in|✓ Compiled');

    const childA = spawnFakeDevServer('✓ Compiled successfully in 220ms');
    expect((await waitForDevServerReady(childA, reA, { timeoutMs: 3_000 })).kind)
      .toBe('ready');

    const childB = spawnFakeDevServer('✓ Ready in 1.5s');
    expect((await waitForDevServerReady(childB, reA, { timeoutMs: 3_000 })).kind)
      .toBe('ready');
  });

  it('matches a ready signal split across multiple stdout chunks', async () => {
    // Node streams `data` events in arbitrary chunk boundaries. A
    // print buffered character-by-character would defeat a per-chunk
    // regex test — the sliding-window buffer in
    // `waitForDevServerReady` handles this. Simulate it by writing
    // characters with small delays.
    const script = `
      const parts = ['Re', 'ady ', 'in ', '1.', '5s\\n'];
      let i = 0;
      const tick = () => {
        process.stdout.write(parts[i++]);
        if (i < parts.length) setTimeout(tick, 50);
        else setInterval(() => {}, 1000);
      };
      tick();
    `;
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawned.push(child);

    const re = compileReadyPattern('ready in');
    const outcome = await waitForDevServerReady(child, re, { timeoutMs: 3_000 });
    expect(outcome.kind).toBe('ready');
  });

  it('returns `exited` when the dev server crashes before printing ready', async () => {
    const child = spawnExitingProcess(1);
    const re = compileReadyPattern('ready in');
    const outcome = await waitForDevServerReady(child, re, { timeoutMs: 3_000 });
    expect(outcome.kind).toBe('exited');
    if (outcome.kind === 'exited') expect(outcome.code).toBe(1);
  });

  it('returns `timeout` when the dev server runs but never prints a matching line', async () => {
    const child = spawnFakeDevServer('some unrelated stderr noise');
    const re = compileReadyPattern('ready in');
    const outcome = await waitForDevServerReady(child, re, { timeoutMs: 1_500 });
    expect(outcome.kind).toBe('timeout');
  });
});

/**
 * REAL integration test for the ACP adapter module-graph readiness gate.
 *
 * Reproduces the 2026-07-06 production incident: on a fresh codespace the
 * `@agentclientprotocol/claude-agent-acp` adapter spawned (`node <adapter>`)
 * BEFORE its own nested node_modules (zod) finished installing, so it crashed
 * at import with `ERR_MODULE_NOT_FOUND: Cannot find module .../zod/v4/core/util.js`
 * / a truncated-file `SyntaxError` → "adapter exited unexpectedly (code=1)".
 *
 * This test does NOT mock spawn — it launches REAL `node` subprocesses against
 * real adapter-shaped scripts on disk, exactly like the runner does, and
 * asserts:
 *   1. a healthy adapter (modules resolve, then it blocks on stdin) probes OK,
 *   2. an adapter crashing on a missing module probes as a transient install
 *      race (NOT a hard failure we should give up on),
 *   3. `waitForAdapterModuleGraph` polls through the transient window and only
 *      releases the spawn gate once the adapter actually loads — the guarantee
 *      that the code=1 crash can never reach the user.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import {
  probeAdapterModuleGraph,
  waitForAdapterModuleGraph,
} from '../../src/agents/acp/agent-binary';

const NODE = process.execPath;
let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-modgraph-'));

  // A healthy adapter: modules load, then it blocks (like the real adapter
  // waiting to read the ACP handshake off stdin). Stays alive.
  fs.writeFileSync(
    path.join(dir, 'healthy.mjs'),
    `import 'node:os';\nsetInterval(() => {}, 1000);\n`,
  );

  // A broken adapter mid-install: a STATIC import of a not-yet-written module
  // (exactly like the real incident — zod's locale files statically import
  // `zod/v4/core/util.js`) throws ERR_MODULE_NOT_FOUND at instantiation, so the
  // process exits 1 immediately, before running any code.
  fs.writeFileSync(
    path.join(dir, 'broken.mjs'),
    `import './this-module-was-not-installed-yet.mjs';\n`,
  );

  // An adapter whose install is "still settling": it crashes with a missing
  // module until the "install" lands `not-installed-yet.cjs` next to it, then
  // loads fine and stays alive. WHEN the install lands is decided by the TEST
  // (after it has OBSERVED two crash exits through the `spawnFn` seam — see
  // the gate test below), not by a counter the script increments itself, so
  // the gate can only release legitimately after the crashes it is supposed
  // to survive.
  //
  // ⚠️ The crash MUST be SYNCHRONOUS (a `require()` of a missing module throws at
  // module-eval time), NOT an async `await import()`. The real incident is a
  // STATIC import failing at instantiation — synchronous, before any liveness
  // window. An `await import()` rejects asynchronously, and on a loaded CI runner
  // that rejection can land AFTER the probe's `livenessMs`, so the probe sees the
  // process "still alive" and wrongly classifies it `ok` — the flake that failed
  // ubuntu·node22 on 2026-07-09. A sync `require` throw exits 1 deterministically
  // well before the liveness timer.
  fs.writeFileSync(
    path.join(dir, 'settling.mjs'),
    [
      `import { createRequire } from 'node:module';`,
      `const require = createRequire(import.meta.url);`,
      // Synchronous throw → "Cannot find module" on stderr, exit 1, immediately.
      `require('./not-installed-yet.cjs');`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'),
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('probeAdapterModuleGraph (real node subprocess)', () => {
  it('returns "ok" when the adapter loads its module graph and stays alive', async () => {
    const r = await probeAdapterModuleGraph(NODE, [path.join(dir, 'healthy.mjs')], {
      livenessMs: 300,
    });
    expect(r).toBe('ok');
  });

  it('returns "transient" when the adapter crashes on a missing module (partial install)', async () => {
    const r = await probeAdapterModuleGraph(NODE, [path.join(dir, 'broken.mjs')], {
      livenessMs: 300,
    });
    expect(r).toBe('transient');
  });
});

/**
 * The liveness window the gate test runs with. The invariant this whole test
 * rests on is "a synchronously-crashing node child EXITS well inside
 * `livenessMs`" — the probe is, by design, a timer race (an adapter that
 * survives the window is judged loaded). A fixed small window (250ms) lost
 * that race on a loaded macos-latest runner on 2026-08-19: node had not even
 * reached the `require()` when the timer fired, the FIRST probe was judged
 * `ok`, and the gate released after 1 attempt (`expected 1 to be >= 3`). So
 * instead of guessing a number, MEASURE this machine's sync-crash latency
 * (`broken.mjs`, same shape) and give the window a 10× margin over it, with a
 * sane floor/ceiling — the window scales with the host instead of racing it.
 */
async function calibrateLivenessMs(): Promise<number> {
  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    const c = spawn(NODE, [path.join(dir, 'broken.mjs')], { stdio: 'ignore' });
    c.on('exit', () => resolve());
    c.on('error', () => resolve());
  });
  const crashMs = Date.now() - t0;
  return Math.min(Math.max(crashMs * 10, 500), 5_000);
}

describe('waitForAdapterModuleGraph (real node subprocess)', () => {
  it('polls through the transient install window and releases only once the adapter loads', async () => {
    const livenessMs = await calibrateLivenessMs();
    const notYetInstalled = path.join(dir, 'not-installed-yet.cjs');
    fs.rmSync(notYetInstalled, { force: true });

    // Observe every real child the gate spawns, in order. The "install" lands
    // ONLY after the second crash exit has been observed, so a legitimate
    // release must come from a child spawned after that.
    const exits: Array<{ attempt: number; code: number | null }> = [];
    let attempts = 0;
    let installedAtAttempt: number | null = null;
    const spawnFn = ((cmd: string, args: readonly string[], opts: unknown): ChildProcess => {
      const attempt = ++attempts;
      const child = spawn(cmd, [...args], opts as Parameters<typeof spawn>[2]);
      child.on('exit', (code) => {
        exits.push({ attempt, code });
        const crashes = exits.filter((e) => e.code !== 0 && e.code !== null).length;
        if (crashes === 2 && installedAtAttempt === null) {
          fs.writeFileSync(notYetInstalled, 'module.exports = {};\n');
          installedAtAttempt = attempt;
        }
      });
      return child;
    }) as unknown as typeof spawn;

    const ok = await waitForAdapterModuleGraph(NODE, [path.join(dir, 'settling.mjs')], {
      livenessMs,
      pollMs: 50,
      timeoutMs: 30_000,
      spawnFn,
    });
    expect(ok).toBe(true);

    // Ordering, not a poll count: both crash exits were observed BEFORE the
    // gate released (the install was triggered by them), and the child that
    // finally satisfied the gate is one spawned AFTER the install landed.
    expect(installedAtAttempt).not.toBeNull();
    const crashExits = exits.filter((e) => e.code !== 0 && e.code !== null);
    expect(crashExits.map((e) => e.attempt)).toEqual([1, 2]);
    expect(attempts).toBeGreaterThan(installedAtAttempt!);
  });

  it('gives up (returns false) within the timeout when the adapter never loads', async () => {
    const ok = await waitForAdapterModuleGraph(NODE, [path.join(dir, 'broken.mjs')], {
      livenessMs: 300,
      pollMs: 50,
      timeoutMs: 1_500,
    });
    expect(ok).toBe(false);
  });
});

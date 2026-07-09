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
  // module for the first 2 spawns (a marker file counts them), then — once the
  // "install" completes — loads fine and stays alive. Proves the gate recovers.
  //
  // ⚠️ The crash MUST be SYNCHRONOUS (a `require()` of a missing module throws at
  // module-eval time), NOT an async `await import()`. The real incident is a
  // STATIC import failing at instantiation — synchronous, before any liveness
  // window. An `await import()` rejects asynchronously, and on a loaded CI runner
  // that rejection can land AFTER the probe's `livenessMs`, so the probe sees the
  // process "still alive" and wrongly classifies it `ok` at attempt 2 — the flake
  // that failed ubuntu·node22 on 2026-07-09 (`expected 2 to be >= 3`). A sync
  // `require` throw exits 1 deterministically well before the liveness timer.
  fs.writeFileSync(
    path.join(dir, 'counter.txt'),
    '0',
  );
  fs.writeFileSync(
    path.join(dir, 'settling.mjs'),
    [
      `import { readFileSync, writeFileSync } from 'node:fs';`,
      `import { fileURLToPath } from 'node:url';`,
      `import { dirname, join } from 'node:path';`,
      `import { createRequire } from 'node:module';`,
      `const require = createRequire(import.meta.url);`,
      `const here = dirname(fileURLToPath(import.meta.url));`,
      `const cfile = join(here, 'counter.txt');`,
      `const n = Number(readFileSync(cfile, 'utf8')) + 1;`,
      `writeFileSync(cfile, String(n));`,
      // Synchronous throw → "Cannot find module" on stderr, exit 1, immediately.
      `if (n <= 2) { require('./not-installed-yet-' + n + '.cjs'); }`,
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

describe('waitForAdapterModuleGraph (real node subprocess)', () => {
  it('polls through the transient install window and releases only once the adapter loads', async () => {
    const ok = await waitForAdapterModuleGraph(NODE, [path.join(dir, 'settling.mjs')], {
      livenessMs: 250,
      pollMs: 50,
      timeoutMs: 15_000,
    });
    expect(ok).toBe(true);
    // It must have actually retried past the 2 crashing spawns.
    const attempts = Number(fs.readFileSync(path.join(dir, 'counter.txt'), 'utf8'));
    expect(attempts).toBeGreaterThanOrEqual(3);
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

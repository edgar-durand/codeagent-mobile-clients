/**
 * Headroom on-demand — REAL Docker integration test.
 *
 * This is NOT a unit test. It proves the full Headroom enable/disable lifecycle
 * end-to-end INSIDE a real Docker container (Python 3.12 + Node 20):
 *
 *   enable: setupHeadroomForSelfHosted('claude', undefined, {extras:['proxy','code','image']})
 *           → real pip install of headroom-ai[proxy,code,image]
 *           → real model pre-download (~840 MB, from HuggingFace)
 *           → real `headroom init --global claude` (rewrites ~/.claude/settings.json)
 *           → real detached `headroom proxy --port 8787`
 *           → driver asserts :8787/stats answers + settings.json mentions 8787
 *
 *   disable: configureHeadroom('disable', ctx, realDeps)
 *            → restoreAgentHeadroomConfig (reverts ~/.claude/settings.json)
 *            → stopProxy (pkill headroom proxy)
 *            → driver asserts :8787/stats no longer answers
 *            → driver asserts `which headroom` still resolves (binary cached)
 *
 * ── Gating ──────────────────────────────────────────────────────────────────
 * Skipped UNLESS `RUN_HEADROOM_INT=1` is set AND `docker info` succeeds.
 * The default `npm run test` NEVER requires Docker or network access; this
 * gate only fires on CI (see .github/workflows/ci.yml "CLI Headroom Docker
 * integration test" step, Linux + Node 20 only) and when a developer
 * explicitly opts in:
 *
 *   RUN_HEADROOM_INT=1 npx vitest run headroom-provision
 *
 * ── Why the timeout is so long ──────────────────────────────────────────────
 * The container's `enable` phase does a REAL pip install of headroom-ai
 * (including the ONNX runtime, transformers, tree-sitter) and pre-downloads
 * the ~840 MB Kompress model from HuggingFace. On a cold cache this can take
 * 5–8 minutes on a typical CI runner. The 600 s per-test limit matches the
 * spec brief and the precedent set by the codespace provisioning timeout.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFileP = promisify(execFile);

// ── Gate checks ──────────────────────────────────────────────────────────────
// Both probed synchronously at module load so the conditional describe is
// resolved without any top-level await — consistent with host-agent.docker.e2e.

const RUN_HEADROOM_INT = process.env.RUN_HEADROOM_INT === '1';

function probeDockerSync(): boolean {
  if (!RUN_HEADROOM_INT) return false;
  try {
    execFileSync('docker', ['info'], { timeout: 15_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dockerReady = probeDockerSync();

// Inform the developer (once, non-failing) why this suite was skipped.
if (!RUN_HEADROOM_INT) {
  // eslint-disable-next-line no-console
  console.log(
    '[headroom-provision] SKIPPED — set RUN_HEADROOM_INT=1 (and have Docker running) to run the real-container gate.',
  );
} else if (!dockerReady) {
  // eslint-disable-next-line no-console
  console.log(
    '[headroom-provision] SKIPPED — RUN_HEADROOM_INT=1 but `docker info` failed (daemon unavailable).',
  );
}

// ── Constants ────────────────────────────────────────────────────────────────
const IMAGE_TAG = `codeam-headroom-provision-e2e:test-${process.pid}`;
const CLI_DIR = path.resolve(__dirname, '../..'); // apps/cli
const DOCKER_DIR = path.join(CLI_DIR, '__tests__', 'docker');
const DOCKERFILE = path.join(DOCKER_DIR, 'headroom-provision.Dockerfile');

/** `docker` shell-out with a generous timeout. */
async function docker(args: string[], timeoutMs = 600_000): Promise<string> {
  const { stdout, stderr } = await execFileP('docker', args, {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
}

/** Run the headroom-runner-driver.js inside a fresh container and return parsed JSON output. */
async function runDriver(
  action: 'enable' | 'disable',
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  // Locate the installed codeam-cli package root in the container.
  // npm global installs go to $(npm root -g)/codeam-cli. We get the driver path
  // by running `node -e "require.resolve('...')"` isn't available for global installs;
  // instead we use `npm root -g` to get the global node_modules dir.
  const containerCmd = [
    'bash', '-c',
    [
      // Resolve the global node_modules root.
      'GLOBAL_ROOT=$(npm root -g)',
      'DRIVER="$GLOBAL_ROOT/codeam-cli/dist/headroom-runner-driver.js"',
      'if [ ! -f "$DRIVER" ]; then echo "{\\"error\\":\\"driver not found at $DRIVER\\"}" && exit 1; fi',
      `node "$DRIVER" ${action}`,
    ].join(' && '),
  ];

  const { stdout } = await execFileP(
    'docker',
    [
      'run',
      '--rm',
      // Give the container enough memory for the ML model load.
      '--memory', '4g',
      IMAGE_TAG,
      ...containerCmd,
    ],
    {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  // The driver writes one JSON object to stdout; there may be pip/hf log noise
  // before it, so find the last complete JSON object.
  const jsonMatch = stdout.match(/(\{[\s\S]*\})\s*$/);
  if (!jsonMatch) {
    throw new Error(
      `Driver (${action}) produced no JSON. stdout:\n${stdout.slice(-2000)}`,
    );
  }
  return JSON.parse(jsonMatch[1]) as Record<string, unknown>;
}

// ── Shared image + tarball state ─────────────────────────────────────────────
let tarballPath = '';

const suite = dockerReady ? describe : describe.skip;

suite('headroom provision — real Docker integration (on-demand enable/disable)', () => {
  // Build once; it is slow (pip install + NodeSource). The actual 840 MB model
  // download happens at RUNTIME (inside `runDriver('enable', …)`) so it is
  // NOT in the image layer and does NOT bloat layer caching.
  beforeAll(async () => {
    // 1) Pack the built CLI.
    const distIndex = path.join(CLI_DIR, 'dist', 'index.js');
    const driverDist = path.join(CLI_DIR, 'dist', 'headroom-runner-driver.js');
    if (!fs.existsSync(distIndex)) {
      throw new Error(
        'dist/index.js missing — run `npm run build` in apps/cli before the Headroom Docker integration test.',
      );
    }
    if (!fs.existsSync(driverDist)) {
      throw new Error(
        'dist/headroom-runner-driver.js missing — run `npm run build` in apps/cli before the Headroom Docker integration test.',
      );
    }

    const packOut = await execFileP('npm', ['pack', '--silent'], {
      cwd: CLI_DIR,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const tarballName = packOut.stdout.trim().split('\n').pop()?.trim();
    if (!tarballName) throw new Error('npm pack produced no tarball name');
    const packedPath = path.join(CLI_DIR, tarballName);

    // Move tarball into the tiny docker build context under a stable name.
    tarballPath = path.join(DOCKER_DIR, 'codeam-cli.tgz');
    fs.copyFileSync(packedPath, tarballPath);
    fs.unlinkSync(packedPath);

    // 2) Build the image. Build context = docker support dir.
    await docker([
      'build',
      '-f', DOCKERFILE,
      '-t', IMAGE_TAG,
      '--build-arg', 'CODEAM_TARBALL=codeam-cli.tgz',
      DOCKER_DIR,
    ], 300_000);
  }, 300_000);

  afterAll(async () => {
    // Remove the test image to avoid polluting the host's Docker image store.
    try {
      await docker(['rmi', '-f', IMAGE_TAG], 30_000);
    } catch { /* best-effort */ }
    // Remove the tarball from the docker support dir.
    if (tarballPath && fs.existsSync(tarballPath)) {
      try {
        fs.unlinkSync(tarballPath);
      } catch { /* best-effort */ }
    }
  });

  it(
    'enable installs headroom, proxy serves /stats, settings.json mentions 8787; disable stops proxy and restores config (binary cached)',
    async () => {
      // ── Phase 1: enable ────────────────────────────────────────────────────
      // Runs the REAL setupHeadroomForSelfHosted inside the container:
      //   pip install headroom-ai[proxy,code,image] + fastapi + uvicorn + …
      //   python3 -c "snapshot_download(…)"  (~840 MB model from HuggingFace)
      //   headroom init --global claude       (rewrites ~/.claude/settings.json)
      //   spawn headroom proxy --port 8787    (detached)
      // Then asserts :8787/stats answers + settings.json contains "8787".
      // eslint-disable-next-line no-console
      console.log('[headroom-provision] Running driver enable (pip install + model download — may take several minutes)…');
      let enableResult: Record<string, unknown>;
      try {
        enableResult = await runDriver('enable', 570_000);
      } catch (err) {
        // Surface raw output for debuggability in CI.
        // eslint-disable-next-line no-console
        console.error('[headroom-provision] enable driver threw:', err instanceof Error ? err.message : err);
        throw err;
      }
      // eslint-disable-next-line no-console
      console.log('[headroom-provision] enable result:', JSON.stringify(enableResult, null, 2));

      expect(
        enableResult['ok'],
        `enable driver failed — checks: ${JSON.stringify(enableResult['checks'])}; error: ${String(enableResult['error'] ?? '')}`,
      ).toBe(true);
      expect(enableResult['checks']).toMatchObject({
        setupReturnedTrue: true,
        proxyAnswers8787: true,
        settingsMentions8787: true,
      });

      // ── Phase 2: disable ───────────────────────────────────────────────────
      // Runs configureHeadroom('disable', …) with real deps inside the container:
      //   restoreAgentHeadroomConfig (reverts ~/.claude/settings.json)
      //   stopProxy (pkill -TERM -f headroom.*proxy)
      // Asserts :8787/stats is no longer accessible + `which headroom` resolves.
      // eslint-disable-next-line no-console
      console.log('[headroom-provision] Running driver disable…');
      let disableResult: Record<string, unknown>;
      try {
        disableResult = await runDriver('disable', 60_000);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[headroom-provision] disable driver threw:', err instanceof Error ? err.message : err);
        throw err;
      }
      // eslint-disable-next-line no-console
      console.log('[headroom-provision] disable result:', JSON.stringify(disableResult, null, 2));

      expect(
        disableResult['ok'],
        `disable driver failed — checks: ${JSON.stringify(disableResult['checks'])}; error: ${String(disableResult['error'] ?? '')}`,
      ).toBe(true);
      expect(disableResult['checks']).toMatchObject({
        proxyDown: true,
        binaryStillCached: true,
      });
    },
    // 600 s covers: pip install (~3 min on cold cache) + model download (~5 min
    // on cold cache) + proxy warm-start + disable/restore.
    600_000,
  );
});

/**
 * Headroom on-demand — REAL Docker integration test.
 *
 * This is NOT a unit test. It proves the full Headroom enable/disable lifecycle
 * end-to-end INSIDE a real Docker container (Python 3.12 + Node 20):
 *
 *   enable: setupHeadroomForSelfHosted('claude', undefined, {extras:['proxy','code','image']})
 *           → pip install is a no-op ("already satisfied" — baked into the image)
 *           → model download is a no-op (warm HF cache — baked into the image)
 *           → real `headroom init --global claude` (rewrites ~/.claude/settings.json)
 *           → real detached `headroom proxy --port 8787`
 *           → driver asserts :8787/stats answers + settings.json mentions 8787
 *
 *   disable: configureHeadroom('disable', ctx, realDeps)
 *            → restoreAgentHeadroomConfig (reverts ~/.claude/settings.json)
 *            → stopProxy (pkill headroom proxy)
 *            → driver asserts :8787/stats no longer answers
 *            → driver asserts `which headroom` still resolves (binary cached)
 *            → driver asserts configRestored (settings.json no longer mentions 8787)
 *
 * ── Container lifecycle ──────────────────────────────────────────────────────
 * Both enable AND disable run inside the SAME persistent container so that
 * disable sees the real state left by enable (pip install, proxy process,
 * rewritten settings.json). The container is started detached in beforeAll
 * (`docker run -d --name <unique> … sleep infinity`), reused for both driver
 * invocations via `docker exec`, and torn down in afterAll even on failure.
 * This mirrors the pattern in `host-agent.docker.e2e.test.ts`.
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
 * ── Why the timeout covers both phases ──────────────────────────────────────
 * The expensive pip install + ~840 MB HuggingFace model download are baked into
 * the Docker IMAGE BUILD layer (not test runtime). Test-time `enable` runs only
 * `headroom init --global claude` + proxy spawn, which takes ~10–30s on the
 * warm-cache image. The 600 s per-test limit is kept as a generous safety net;
 * the beforeAll image-build step has its own 600 s budget for cold builds.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

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
// If HEADROOM_IMAGE_TAG is set (e.g. by CI after a pre-built image is loaded
// into the daemon), the test skips its own `docker build` and reuses that tag
// directly. The local default (unset) retains the original self-build flow so
// `RUN_HEADROOM_INT=1 npm run test -- headroom-provision` works with no extra setup.
const PROVIDED_IMAGE_TAG = process.env.HEADROOM_IMAGE_TAG ?? '';
const IMAGE_TAG = PROVIDED_IMAGE_TAG || `codeam-headroom-provision-e2e:test-${process.pid}`;
const CONTAINER_NAME = `codeam-headroom-provision-e2e-${process.pid}`;
const CLI_DIR = path.resolve(__dirname, '../..'); // apps/cli
const DOCKER_DIR = path.join(CLI_DIR, '__tests__', 'docker');
const DOCKERFILE = path.join(DOCKER_DIR, 'headroom-provision.Dockerfile');

// ── Zod schema for driver output ─────────────────────────────────────────────
// The driver writes a JSON object with the fields the test cares about.
// Using zod ensures the cast from JSON.parse happens at a validated boundary
// (CLAUDE.md typing rules: "as is allowed only at validated boundaries").
const DriverOutputSchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
  checks: z
    .object({
      // enable-phase fields
      setupReturnedTrue: z.boolean().optional(),
      proxyAnswers8787: z.boolean().optional(),
      settingsMentions8787: z.boolean().optional(),
      // disable-phase fields
      proxyDown: z.boolean().optional(),
      configRestored: z.boolean().optional(),
      binaryStillCached: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();

type DriverOutput = z.infer<typeof DriverOutputSchema>;

/**
 * Surface the stdout + stderr from an `execFileP` rejection.
 *
 * `execFileP` rejects with a `ChildProcess` error that carries `.stdout` and
 * `.stderr` as `Buffer | string | null`. We surface both so CI logs always show
 * the driver's output rather than the opaque "Command failed: docker exec …"
 * message that was the root cause of blind failures.
 */
function dockerExecError(action: string, err: unknown, fallbackStdout = ''): Error {
  // execFileP errors from child_process carry `.stdout` / `.stderr` buffers.
  // We access them via index access (no `as`): the fields may be Buffer or
  // string; toString() handles both.
  const errObj = err as { stdout?: Buffer | string | null; stderr?: Buffer | string | null; message?: string };
  const stdout = errObj.stdout != null ? String(errObj.stdout) : fallbackStdout;
  const stderr = errObj.stderr != null ? String(errObj.stderr) : '';
  const base = errObj.message ?? String(err);
  const parts = [`enable driver docker exec failed: ${base}`];
  if (stdout) parts.push(`--- stdout (last 4000 chars) ---\n${stdout.slice(-4000)}`);
  if (stderr) parts.push(`--- stderr (last 4000 chars) ---\n${stderr.slice(-4000)}`);
  return new Error(`[headroom-provision] ${action} docker exec failed:\n${parts.join('\n')}`);
}

/** `docker` shell-out with a generous timeout. */
async function docker(args: string[], timeoutMs = 600_000): Promise<string> {
  const { stdout, stderr } = await execFileP('docker', args, {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
}

async function removeContainerQuiet(): Promise<void> {
  try {
    await docker(['rm', '-f', CONTAINER_NAME], 30_000);
  } catch {
    /* not running — ignore */
  }
}

/**
 * Run the headroom-runner-driver.js inside the PERSISTENT container via
 * `docker exec` and return the validated parsed output.
 *
 * Both enable and disable share the same container so that disable sees the
 * real state (pip install, proxy process, rewritten settings.json) that enable
 * left behind. Running each phase in a separate `docker run --rm` container
 * would start each phase from a clean image — making the disable phase prove
 * nothing (no proxy running, no settings.json to restore, binary absent).
 */
async function runDriver(
  action: 'enable' | 'disable',
  timeoutMs: number,
): Promise<DriverOutput> {
  // Resolve the global node_modules driver path inside the container.
  const containerCmd = [
    'bash', '-c',
    [
      'GLOBAL_ROOT=$(npm root -g)',
      'DRIVER="$GLOBAL_ROOT/codeam-cli/dist/headroom-runner-driver.js"',
      'if [ ! -f "$DRIVER" ]; then echo "{\\"error\\":\\"driver not found at $DRIVER\\"}" && exit 1; fi',
      `node "$DRIVER" ${action}`,
    ].join(' && '),
  ];

  let stdout: string;
  let stderr: string;
  try {
    const result = await execFileP(
      'docker',
      ['exec', CONTAINER_NAME, ...containerCmd],
      {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    stdout = result.stdout;
    stderr = result.stderr ?? '';
  } catch (err) {
    // Surface the driver's full stdout + stderr so CI logs show the real failure
    // cause rather than the opaque "Command failed: docker exec …".
    throw dockerExecError(action, err);
  }

  // Log stderr for visibility even on success (pip/hf warnings go there).
  if (stderr) {
    // eslint-disable-next-line no-console
    console.log(`[headroom-provision] ${action} driver stderr:\n${stderr.slice(-2000)}`);
  }

  // The driver writes multiple single-line JSON objects (progress markers) and
  // ends with one multi-line JSON result object. Find the last JSON object
  // by splitting on newlines and trying each line from the end.
  // We look for lines that start with '{' and are individually valid JSON.
  const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{'));
  // Try to parse from the end; the result object may span multiple lines
  // (the driver uses JSON.stringify with indent-2), so we also try to join
  // a suffix of lines and parse as one block.
  let parsed: DriverOutput | undefined;

  // First attempt: try joining all remaining lines from the last complete-looking block.
  // The final output block starts at the last occurrence of a line whose content
  // is `{` (or `{\n`) — the pretty-printed JSON.stringify output.
  const lastBlockIdx = (() => {
    const rawLines = stdout.split('\n');
    for (let i = rawLines.length - 1; i >= 0; i--) {
      if (rawLines[i].trimEnd() === '{') return i;
    }
    return -1;
  })();

  if (lastBlockIdx >= 0) {
    const candidate = stdout.split('\n').slice(lastBlockIdx).join('\n').trim();
    try {
      parsed = DriverOutputSchema.parse(JSON.parse(candidate));
    } catch {
      /* fallthrough to line-by-line search */
    }
  }

  // Fallback: each line from the end might be a complete single-line JSON object.
  if (!parsed) {
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const candidate = DriverOutputSchema.parse(JSON.parse(lines[i]));
        // Only accept if it has an 'action' field (the final result, not a progress marker).
        if (typeof candidate.ok === 'boolean') {
          parsed = candidate;
          break;
        }
      } catch {
        /* not valid JSON or not the right shape — continue */
      }
    }
  }

  if (!parsed) {
    throw new Error(
      `Driver (${action}) produced no parseable result JSON.\nstdout (last 3000):\n${stdout.slice(-3000)}\nstderr (last 2000):\n${stderr.slice(-2000)}`,
    );
  }

  return parsed;
}

// ── Shared image + tarball + container state ──────────────────────────────────
let tarballPath = '';

const suite = dockerReady ? describe : describe.skip;

suite('headroom provision — real Docker integration (on-demand enable/disable)', () => {
  // Build (or reuse a pre-built image) and start the persistent container;
  // both phases reuse it.
  beforeAll(async () => {
    // Ensure no leftover container from a previous crashed run.
    await removeContainerQuiet();

    if (PROVIDED_IMAGE_TAG) {
      // ── Reuse path (CI pre-built the image and set HEADROOM_IMAGE_TAG) ──────
      // Skip npm pack + docker build entirely. The image is already loaded into
      // the daemon by the CI pre-build step, so we just start the container.
      // eslint-disable-next-line no-console
      console.log(`[headroom-provision] Reusing pre-built image ${PROVIDED_IMAGE_TAG} (HEADROOM_IMAGE_TAG is set — skipping docker build).`);
    } else {
      // ── Self-build path (local developer, no HEADROOM_IMAGE_TAG set) ────────
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

      // The driver is excluded from the published tarball (test-only code).
      // Copy it separately into the docker build context so the Dockerfile can
      // install it at $(npm root -g)/codeam-cli/dist/ alongside the CLI.
      fs.copyFileSync(
        driverDist,
        path.join(DOCKER_DIR, 'headroom-runner-driver.js'),
      );

      // 2) Build the image. Build context = docker support dir.
      //    On a cold cache (first build) this includes pip install + the ~840 MB
      //    HuggingFace model download baked into the image — allow up to 600s.
      //    On a warm Docker layer cache (subsequent CI runs) it completes in <30s.
      // eslint-disable-next-line no-console
      console.log('[headroom-provision] Building Docker image (pip install + model baked in — cold build may take several minutes)…');
      await docker([
        'build',
        '-f', DOCKERFILE,
        '-t', IMAGE_TAG,
        '--build-arg', 'CODEAM_TARBALL=codeam-cli.tgz',
        DOCKER_DIR,
      ], 600_000);
    }

    // 3) Start a PERSISTENT container that lives for the entire test suite.
    //    Both enable and disable run inside it via `docker exec` so that
    //    disable sees the real state left by enable (pip install, proxy
    //    process, rewritten ~/.claude/settings.json).
    await docker([
      'run',
      '-d',
      '--name', CONTAINER_NAME,
      '--memory', '4g',
      IMAGE_TAG,
      'sleep', 'infinity',
    ], 30_000);
  }, 660_000); // image build (600s cold / fast on warm cache) + pack/start overhead

  afterAll(async () => {
    // Tear down the container even on failure.
    await removeContainerQuiet();
    if (!PROVIDED_IMAGE_TAG) {
      // Remove the test image to avoid polluting the host's Docker image store.
      // When using a CI-provided image (PROVIDED_IMAGE_TAG), the caller owns
      // the image lifecycle — we leave it in place.
      try {
        await docker(['rmi', '-f', IMAGE_TAG], 30_000);
      } catch { /* best-effort */ }
      // Remove the tarball and driver copy from the docker support dir.
      // These are only created in the self-build path.
      for (const tempFile of [
        tarballPath,
        path.join(DOCKER_DIR, 'headroom-runner-driver.js'),
      ]) {
        if (tempFile && fs.existsSync(tempFile)) {
          try {
            fs.unlinkSync(tempFile);
          } catch { /* best-effort */ }
        }
      }
    }
  });

  it(
    'enable installs headroom, proxy serves /stats, settings.json mentions 8787; disable stops proxy, restores config, binary cached',
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
      let enableResult: DriverOutput;
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
        enableResult.ok,
        `enable driver failed — checks: ${JSON.stringify(enableResult.checks)}; error: ${String(enableResult.error ?? '')}`,
      ).toBe(true);
      expect(enableResult.checks).toMatchObject({
        setupReturnedTrue: true,
        proxyAnswers8787: true,
        settingsMentions8787: true,
      });

      // ── Phase 2: disable ───────────────────────────────────────────────────
      // Runs configureHeadroom('disable', …) with real deps inside the SAME
      // container — so the proxy is actually running and settings.json is the
      // headroom-rewritten version. This is the only way to prove that
      // restoreAgentHeadroomConfig and stopProxy actually work.
      //
      // If disable ran in a fresh `docker run --rm` container it would see:
      //   - no proxy process → proxyDown would be vacuously true
      //   - no settings.json → configRestored would be vacuously true
      //   - no pip install → binaryStillCached would be FALSE → test FAILS
      // All three checks would be meaningless or wrong.
      // eslint-disable-next-line no-console
      console.log('[headroom-provision] Running driver disable (in the same container)…');
      let disableResult: DriverOutput;
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
        disableResult.ok,
        `disable driver failed — checks: ${JSON.stringify(disableResult.checks)}; error: ${String(disableResult.error ?? '')}`,
      ).toBe(true);
      expect(disableResult.checks).toMatchObject({
        proxyDown: true,
        configRestored: true,       // I5: spec requires "disable restores the agent config"
        binaryStillCached: true,
      });
    },
    // 600 s covers: headroom init (~10s) + proxy warm-start (model already baked
    // into the image) + /stats probe + disable/restore. The heavy pip install and
    // model download now happen at image BUILD time (baked into Dockerfile layers),
    // so test-time enable is fast and deterministic.
    600_000,
  );
});

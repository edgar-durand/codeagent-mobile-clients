/**
 * `codeam mcp-run` shim — REAL Docker integration test.
 *
 * This is NOT a unit test. It proves the integration-MCP shim end-to-end
 * INSIDE a real Docker container (Python 3.12 + uv + Node 20), against the
 * REAL, pinned mcp-atlassian — only the CodeAgent backend is faked:
 *
 *   • fake broker (node http server inside the container) answers
 *     POST /api/plugin/integrations/jira/token: first call → tok-1 with a
 *     NEAR expiry (~6 min), later calls → tok-2 (+1 h)
 *   • ~/.codeam/integrations.json is written WITHOUT staticEnv, deliberately
 *     mimicking a manifest from a pre-staticEnv backend (≤ 2.60.46) — the run
 *     therefore also proves the shim's rollout defense (bundled-registry
 *     staticEnv merged underneath: ATLASSIAN_OAUTH_ENABLE=true still set,
 *     without which mcp-atlassian lists ZERO tools)
 *   • `codeam mcp-run jira` is spawned with the CODEAM_MCP_* env contract and
 *     CODEAM_API_URL (the resolveApiBaseUrl override) pointed at the broker
 *   • initialize + tools/list over stdio → real jira_* tool list (dummy creds
 *     are fine: mcp-atlassian validates credentials lazily, at tool CALL time)
 *   • /proc + `ps -eo args`: the token appears ONLY in the mcp-atlassian
 *     process env, NEVER in any argv
 *   • the shim's 30 s restart tick crosses tok-1's 5-min-ahead window at
 *     ~90 s → child swapped (broker sees a 2nd token request) → a
 *     post-restart tools/list still answers and the tok-1 child is gone
 *
 * ── Container lifecycle ──────────────────────────────────────────────────────
 * Image build bakes the network-bound work (NodeSource apt, pip install uv,
 * uvx prewarm of the PINNED mcp-atlassian, npm -g of the packed CLI) into
 * layer-cached build steps — mirrors headroom-provision.Dockerfile. The test
 * starts a detached container and runs the plain-JS driver
 * (__tests__/docker/mcp-shim-driver.js) via `docker exec`.
 *
 * ── Gating ──────────────────────────────────────────────────────────────────
 * Skipped UNLESS `RUN_INTEGRATIONS_INT=1` is set AND `docker info` succeeds:
 *
 *   RUN_INTEGRATIONS_INT=1 npx vitest run mcp-shim
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { INTEGRATION_REGISTRY } from '@codeam/shared';

const execFileP = promisify(execFile);

// ── Gate checks (headroom-provision skeleton) ────────────────────────────────
const RUN_INTEGRATIONS_INT = process.env.RUN_INTEGRATIONS_INT === '1';

function probeDockerSync(): boolean {
  if (!RUN_INTEGRATIONS_INT) return false;
  try {
    execFileSync('docker', ['info'], { timeout: 15_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dockerReady = probeDockerSync();

if (!RUN_INTEGRATIONS_INT) {
  // eslint-disable-next-line no-console
  console.log(
    '[mcp-shim] SKIPPED — set RUN_INTEGRATIONS_INT=1 (and have Docker running) to run the real-container gate.',
  );
} else if (!dockerReady) {
  // eslint-disable-next-line no-console
  console.log(
    '[mcp-shim] SKIPPED — RUN_INTEGRATIONS_INT=1 but `docker info` failed (daemon unavailable).',
  );
}

// ── Constants ────────────────────────────────────────────────────────────────
const IMAGE_TAG = `codeam-mcp-shim-int:test-${process.pid}`;
const CONTAINER_NAME = `codeam-mcp-shim-int-${process.pid}`;
const CLI_DIR = path.resolve(__dirname, '../..'); // apps/cli
const DOCKER_DIR = path.join(CLI_DIR, '__tests__', 'docker');
const DOCKERFILE = path.join(DOCKER_DIR, 'mcp-shim.Dockerfile');

/** The image prewarms EXACTLY the pin the registry ships — a pin bump re-warms
 *  automatically and the test can never drift from the shipped spec. */
const MCP_PIN = INTEGRATION_REGISTRY.jira.delivery.mcp!.args[0];

// ── Driver output schema (validated boundary for the JSON.parse cast) ────────
const DriverOutputSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    checks: z
      .object({
        initializeOk: z.boolean().optional(),
        serverName: z.string().nullable().optional(),
        toolCount: z.number().optional(),
        jiraToolCount: z.number().optional(),
        hasJiraGetIssue: z.boolean().optional(),
        tok1InChildEnv: z.boolean().optional(),
        tok1ArgvLeak: z.boolean().optional(),
        tok1InPsArgs: z.boolean().optional(),
        brokerCalls: z.number().optional(),
        restartTriggered: z.boolean().optional(),
        postRestartToolCount: z.number().optional(),
        postRestartOk: z.boolean().optional(),
        tok2InChildEnv: z.boolean().optional(),
        tok2ArgvLeak: z.boolean().optional(),
        tok1ChildGone: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type DriverOutput = z.infer<typeof DriverOutputSchema>;

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

let tarballPath = '';

const suite = dockerReady ? describe : describe.skip;

suite('mcp-run shim — real Docker integration (broker → uvx mcp-atlassian → restart)', () => {
  beforeAll(async () => {
    await removeContainerQuiet();

    // 1) Pack the built CLI.
    const distIndex = path.join(CLI_DIR, 'dist', 'index.js');
    if (!fs.existsSync(distIndex)) {
      throw new Error(
        'dist/index.js missing — run `npm run build` in apps/cli before the mcp-shim Docker integration test.',
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
    tarballPath = path.join(DOCKER_DIR, 'codeam-cli-mcp-shim.tgz');
    fs.copyFileSync(packedPath, tarballPath);
    fs.unlinkSync(packedPath);

    // 2) Build the image (uvx prewarm of the PINNED mcp-atlassian baked in).
    // eslint-disable-next-line no-console
    console.log(`[mcp-shim] Building Docker image (prewarming uvx ${MCP_PIN})…`);
    await docker(
      [
        'build',
        '-f',
        DOCKERFILE,
        '-t',
        IMAGE_TAG,
        '--build-arg',
        'CODEAM_TARBALL=codeam-cli-mcp-shim.tgz',
        '--build-arg',
        `MCP_ATLASSIAN_PIN=${MCP_PIN}`,
        DOCKER_DIR,
      ],
      600_000,
    );

    // 3) Start the detached container the driver runs in.
    await docker(
      ['run', '-d', '--name', CONTAINER_NAME, '--memory', '2g', IMAGE_TAG, 'sleep', 'infinity'],
      30_000,
    );
  }, 660_000);

  afterAll(async () => {
    await removeContainerQuiet();
    try {
      await docker(['rmi', '-f', IMAGE_TAG], 30_000);
    } catch {
      /* best-effort */
    }
    if (tarballPath && fs.existsSync(tarballPath)) {
      try {
        fs.unlinkSync(tarballPath);
      } catch {
        /* best-effort */
      }
    }
  });

  it(
    'brokers a token, lists real jira tools, keeps the token out of argv, and survives the expiry-driven restart',
    async () => {
      let stdout: string;
      let stderr = '';
      try {
        const result = await execFileP(
          'docker',
          [
            'exec',
            '-e',
            `MCP_ATLASSIAN_PIN=${MCP_PIN}`,
            CONTAINER_NAME,
            'node',
            '/opt/mcp-shim-driver.js',
          ],
          { timeout: 480_000, maxBuffer: 64 * 1024 * 1024 },
        );
        stdout = result.stdout;
        stderr = result.stderr ?? '';
      } catch (err) {
        // Surface the driver's stdout/stderr instead of the opaque
        // "Command failed: docker exec …" (headroom lesson).
        const e = err as { stdout?: string | Buffer | null; stderr?: string | Buffer | null; message?: string };
        throw new Error(
          `[mcp-shim] driver docker exec failed: ${e.message ?? String(err)}\n--- stdout (last 4000) ---\n${String(e.stdout ?? '').slice(-4000)}\n--- stderr (last 4000) ---\n${String(e.stderr ?? '').slice(-4000)}`,
        );
      }

      if (stderr) {
        // eslint-disable-next-line no-console
        console.log(`[mcp-shim] driver stderr (last 3000):\n${stderr.slice(-3000)}`);
      }

      // The driver emits exactly one JSON result line on stdout (last line).
      const lastJsonLine = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('{'))
        .pop();
      if (!lastJsonLine) {
        throw new Error(`[mcp-shim] driver produced no JSON result.\nstdout:\n${stdout.slice(-3000)}`);
      }
      const out: DriverOutput = DriverOutputSchema.parse(JSON.parse(lastJsonLine));
      // eslint-disable-next-line no-console
      console.log('[mcp-shim] driver result:', JSON.stringify(out, null, 2));

      expect(
        out.ok,
        `driver failed — error: ${String(out.error ?? '')}; checks: ${JSON.stringify(out.checks)}`,
      ).toBe(true);
      expect(out.checks).toMatchObject({
        initializeOk: true,
        // The rollout defense is what makes this non-zero: the manifest had NO
        // staticEnv, so tools only list because the shim merged the bundled
        // registry's ATLASSIAN_OAUTH_ENABLE=true underneath it.
        hasJiraGetIssue: true,
        // Token placement: env only, never argv.
        tok1InChildEnv: true,
        tok1ArgvLeak: false,
        tok1InPsArgs: false,
        // Expiry-driven restart really happened and the session survived it.
        restartTriggered: true,
        postRestartOk: true,
        tok2InChildEnv: true,
        tok2ArgvLeak: false,
        tok1ChildGone: true,
      });
      expect(out.checks?.jiraToolCount ?? 0).toBeGreaterThanOrEqual(50);
      expect(out.checks?.brokerCalls ?? 0).toBeGreaterThanOrEqual(2);
      expect(out.checks?.postRestartToolCount ?? 0).toBeGreaterThanOrEqual(50);
    },
    // Driver runtime: warm-cache uvx spawn (~10 s) + tools/list + ~90–120 s
    // expiry wait + post-restart handshake — 480 s exec budget + slack.
    540_000,
  );
});

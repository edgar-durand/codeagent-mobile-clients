/**
 * Per-agent REAL install — Docker integration gate.
 *
 * ─── Why this exists (owner mandate) ────────────────────────────────────────
 * The **stale-PATH / half-finished-install** failure class must be caught in
 * CI, never again in production. It has now bitten four different agents on
 * four different seams, and every single time it looked identical from the
 * outside: the install succeeds, and then the agent "isn't installed".
 *
 *   • codex   (fleet-1, 2026-08-14) — `npm i -g @openai/codex` landed the
 *     binary in the per-user npm prefix (`~/.local/bin`); the daemon's systemd
 *     PATH never had that dir, so the probe reported "installed but its binary
 *     never appeared on PATH" forever, and the box was also found with a
 *     HALF-FINISHED npm bin link (`.codex-ykcFwAyA` present, `codex` absent).
 *   • cursor / coderabbit / aider — found by THIS gate on its first run; see
 *     the per-agent notes below.
 *
 * No unit test can catch this class. It needs (1) a real install, (2) a real
 * minimal PATH, and (3) a single long-running process that captured its PATH
 * BEFORE the install — which is exactly what this gate builds.
 *
 * ─── What each agent case proves ────────────────────────────────────────────
 * Inside a fresh container (base + system deps mirroring `apps/box/Dockerfile`),
 * as a NON-ROOT user with a real HOME and a deliberately minimal, systemd-like
 * PATH (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin`), ONE node process
 * (`dist/agent-install-driver.js` — the simulated CLI daemon):
 *
 *   a) resolves the agent's ACP adapter spec (production's first step, and the
 *      point at which `getAcpAdapter` permanently caches `spec.command`);
 *   b) runs the CANONICAL install snippet from `@codeam/shared`
 *      (`INSTALL_SNIPPETS`) through the REAL `runAgentInstallScript`;
 *   c) invokes the REAL probe — `getAcpAdapter(agent).waitForBinary()`, or the
 *      runtime's own binary resolution for the non-ACP agents;
 *   d) spawns `<binary> --version` from that same process.
 *
 * ⚠️ The gate FAILS — never skips — when an install succeeds but the probe or
 * the spawn can't see the binary. That combination IS the bug being guarded.
 *
 * ─── Gating ─────────────────────────────────────────────────────────────────
 * Skipped unless `RUN_AGENT_INSTALL_INT=1` AND `docker info` succeeds. The
 * default `npm run test` never needs Docker or network. Run it explicitly:
 *
 *   (cd apps/cli && npm run build)
 *   RUN_AGENT_INSTALL_INT=1 npx vitest run agent-install.int
 *
 * CI: `.github/workflows/agent-install-int.yml` (PRs touching the agent code +
 * a nightly cron). Deliberately NOT a required check — these are real network
 * installs against six vendors and will occasionally flake; visibility first.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { AGENT_INSTALL_CASES } from '../fixtures/agent-install-cases';

const execFileP = promisify(execFile);

// ── Gate checks (sync at module load — no top-level await) ───────────────────

const RUN_AGENT_INSTALL_INT = process.env.RUN_AGENT_INSTALL_INT === '1';

function probeDockerSync(): boolean {
  if (!RUN_AGENT_INSTALL_INT) return false;
  try {
    execFileSync('docker', ['info'], { timeout: 15_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dockerReady = probeDockerSync();

if (!RUN_AGENT_INSTALL_INT) {
  // eslint-disable-next-line no-console
  console.log(
    '[agent-install] SKIPPED — set RUN_AGENT_INSTALL_INT=1 (and have Docker running) to run the real per-agent install gate.',
  );
} else if (!dockerReady) {
  // eslint-disable-next-line no-console
  console.log(
    '[agent-install] SKIPPED — RUN_AGENT_INSTALL_INT=1 but `docker info` failed (daemon unavailable).',
  );
}

// ── Constants ────────────────────────────────────────────────────────────────

const PROVIDED_IMAGE_TAG = process.env.AGENT_INSTALL_IMAGE_TAG ?? '';
const IMAGE_TAG = PROVIDED_IMAGE_TAG || `codeam-agent-install:test-${process.pid}`;
const CLI_DIR = path.resolve(__dirname, '../..'); // apps/cli
const DOCKER_DIR = path.join(CLI_DIR, '__tests__', 'docker');
const DOCKERFILE = path.join(DOCKER_DIR, 'agent-install.Dockerfile');
const DRIVER_IN_CONTAINER = '/usr/local/lib/node_modules/codeam-cli/dist/agent-install-driver.js';

/**
 * The fleet-1 condition, reproduced verbatim: the PATH a systemd unit gets.
 * NOTHING an agent installer writes to is on it.
 */
const MINIMAL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin';

/** Real network installs against six vendors — generous, serial. */
const PER_AGENT_TIMEOUT_MS = 300_000;

// ── Driver output contract ───────────────────────────────────────────────────

const ChecksSchema = z
  .object({
    installDirOffStartingPath: z.boolean().optional(),
    adapterCommandAtStart: z.string().optional(),
    installOk: z.boolean().optional(),
    probeResolved: z.boolean().optional(),
    versionExitZero: z.boolean().optional(),
    versionOutput: z.string().optional(),
    halfLinkStaged: z.boolean().optional(),
    probeFailedWhileLinkBroken: z.boolean().optional(),
    ensureOk: z.boolean().optional(),
    ensureError: z.string().optional(),
    probeResolvedAfterEnsure: z.boolean().optional(),
  })
  .loose();

const DriverResultSchema = z
  .object({
    agentId: z.string(),
    mode: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    pathAtStart: z.string(),
    pathAtEnd: z.string(),
    checks: ChecksSchema,
  })
  .loose();

type DriverResult = z.infer<typeof DriverResultSchema>;

const RESULT_MARKER = '__AGENT_INSTALL_RESULT__';

/**
 * Per-agent decision table. Defined in `__tests__/fixtures/` and shared with
 * `__tests__/agents/agent-install-cases.test.ts`, which asserts it covers every
 * `INSTALL_SNIPPETS` key. That coverage assertion deliberately lives in the
 * PLAIN unit suite — inside this Docker-gated suite it would never run on a PR.
 */
const CASES = AGENT_INSTALL_CASES;

// ── docker helpers ───────────────────────────────────────────────────────────

async function docker(args: string[], timeoutMs = 600_000): Promise<string> {
  const { stdout, stderr } = await execFileP('docker', args, {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
}

/** Never throws — the driver exits non-zero on a failed case, and we want its output. */
async function dockerExecRaw(args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout, stderr } = await execFileP('docker', args, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return `${stdout}\n${stderr ?? ''}`;
  } catch (err) {
    const e = err as {
      stdout?: Buffer | string | null;
      stderr?: Buffer | string | null;
      message?: string;
    };
    const out = e.stdout != null ? String(e.stdout) : '';
    const errOut = e.stderr != null ? String(e.stderr) : '';
    return `${out}\n${errOut}\n[docker exec error] ${e.message ?? String(err)}`;
  }
}

const containers = new Set<string>();

async function startContainer(name: string): Promise<void> {
  // ⚠️ Register BEFORE `docker run`. If the run times out or the daemon is slow
  // to answer, the container can still exist while the call rejects — a name
  // registered only on success would leak it past afterAll. `docker rm -f` on a
  // name that was never created is a harmless no-op, so over-registering costs
  // nothing and under-registering leaks a container per failed run.
  containers.add(name);
  await docker(['rm', '-f', name], 30_000).catch(() => undefined);
  await docker(['run', '-d', '--name', name, IMAGE_TAG], 60_000);
}

async function removeContainerQuiet(name: string): Promise<void> {
  try {
    await docker(['rm', '-f', name], 30_000);
  } catch {
    /* already gone */
  }
  containers.delete(name);
}

/**
 * Run the driver in `container` with the MINIMAL PATH.
 *
 * `CODEAM_AUTO_APPROVE=1` makes `isLocalSession()` false, so kimi's and
 * opencode's `waitForBinary` do NOT quietly run their own on-demand installer.
 * That is both the self-hosted/fleet shape AND what keeps the case honest —
 * otherwise the probe could install the very binary it is meant to be probing
 * for, and a broken snippet would still look green.
 */
async function runDriver(
  container: string,
  agentId: string,
  mode: 'install-probe' | 'half-link',
  timeoutMs: number,
): Promise<{ result: DriverResult | null; raw: string }> {
  const raw = await dockerExecRaw(
    [
      'exec',
      '-u',
      'agent',
      '-e',
      `PATH=${MINIMAL_PATH}`,
      '-e',
      'HOME=/home/agent',
      '-e',
      'CODEAM_AUTO_APPROVE=1',
      container,
      'node',
      DRIVER_IN_CONTAINER,
      agentId,
      mode,
    ],
    timeoutMs,
  );
  const line = raw
    .split('\n')
    .reverse()
    .find((l) => l.includes(RESULT_MARKER));
  if (!line) return { result: null, raw };
  const json = line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length).trim();
  try {
    return { result: DriverResultSchema.parse(JSON.parse(json)), raw };
  } catch {
    return { result: null, raw };
  }
}

/** Assert + report: a missing result must surface the container output. */
function requireResult(
  agentId: string,
  mode: string,
  out: { result: DriverResult | null; raw: string },
): DriverResult {
  if (!out.result) {
    throw new Error(
      `[agent-install] ${agentId} (${mode}) produced no parseable result.\n--- container output (last 4000 chars) ---\n${out.raw.slice(-4000)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[agent-install] ${agentId} (${mode}):`, JSON.stringify(out.result));
  return out.result;
}

// ── Suite ────────────────────────────────────────────────────────────────────

let tarballPath = '';
let driverCopyPath = '';

const suite = dockerReady ? describe : describe.skip;

suite('per-agent REAL install — Docker integration (stale-PATH / half-install gate)', () => {
  beforeAll(async () => {
    if (PROVIDED_IMAGE_TAG) {
      // eslint-disable-next-line no-console
      console.log(`[agent-install] Reusing pre-built image ${PROVIDED_IMAGE_TAG}.`);
      return;
    }
    const distIndex = path.join(CLI_DIR, 'dist', 'index.js');
    const driverDist = path.join(CLI_DIR, 'dist', 'agent-install-driver.js');
    for (const required of [distIndex, driverDist]) {
      if (!fs.existsSync(required)) {
        throw new Error(
          `${path.relative(CLI_DIR, required)} missing — run \`npm run build\` in apps/cli before the agent-install integration test.`,
        );
      }
    }

    const packOut = await execFileP('npm', ['pack', '--silent'], {
      cwd: CLI_DIR,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const tarballName = packOut.stdout.trim().split('\n').pop()?.trim();
    if (!tarballName) throw new Error('npm pack produced no tarball name');
    tarballPath = path.join(DOCKER_DIR, 'codeam-cli.tgz');
    fs.copyFileSync(path.join(CLI_DIR, tarballName), tarballPath);
    fs.unlinkSync(path.join(CLI_DIR, tarballName));

    // The driver is excluded from the published tarball (test-only), so it
    // rides into the build context on its own — same as the headroom driver.
    driverCopyPath = path.join(DOCKER_DIR, 'agent-install-driver.js');
    fs.copyFileSync(driverDist, driverCopyPath);

    // eslint-disable-next-line no-console
    console.log('[agent-install] Building the test image…');
    await docker(
      [
        'build',
        '-f',
        DOCKERFILE,
        '-t',
        IMAGE_TAG,
        '--build-arg',
        'CODEAM_TARBALL=codeam-cli.tgz',
        DOCKER_DIR,
      ],
      600_000,
    );
  }, 660_000);

  afterAll(async () => {
    for (const name of [...containers]) await removeContainerQuiet(name);
    if (PROVIDED_IMAGE_TAG) return;
    try {
      await docker(['rmi', '-f', IMAGE_TAG], 60_000);
    } catch {
      /* best-effort */
    }
    for (const tmp of [tarballPath, driverCopyPath]) {
      if (tmp && fs.existsSync(tmp)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* best-effort */
        }
      }
    }
  }, 120_000);

  // The table's COVERAGE of INSTALL_SNIPPETS is asserted in the plain unit
  // suite (`__tests__/agents/agent-install-cases.test.ts`) so it runs on every
  // PR, not only when this Docker gate is enabled.
  for (const [agentId, agentCase] of Object.entries(CASES)) {
    if (agentCase.kind === 'tracked-skip') {
      it.skip(`${agentId} — TRACKED SKIP: ${agentCase.reason}`, () => undefined);
      continue;
    }

    it(
      `${agentId}: real install → adapter probe sees it → \`--version\` runs (${agentCase.note})`,
      async () => {
        const container = `codeam-agent-install-${agentId}-${process.pid}`;
        await startContainer(container);
        try {
          const result = requireResult(
            agentId,
            'install-probe',
            await runDriver(container, agentId, 'install-probe', PER_AGENT_TIMEOUT_MS),
          );

          // Precondition: the gate is only meaningful if the installer's target
          // dir was absent from the process's captured PATH.
          expect(
            result.checks.installDirOffStartingPath,
            `${agentId}: the install dir was already on the starting PATH — this case proves nothing`,
          ).toBe(true);
          expect(result.pathAtStart).toBe(MINIMAL_PATH);

          expect(
            result.checks.installOk,
            `${agentId}: the canonical install snippet failed: ${result.error ?? ''}`,
          ).toBe(true);

          // ⚠️ THE guarded class. A successful install the probe can't see is a
          // FAILURE here, never a skip.
          expect(
            result.checks.probeResolved,
            `${agentId}: installed, but the real probe never saw the binary (stale-PATH class). ${result.error ?? ''}`,
          ).toBe(true);

          // …and the process that did the probing must be able to RUN it.
          expect(
            result.checks.versionExitZero,
            `${agentId}: probe passed but the spawn failed from the same process — ${result.checks.versionOutput ?? ''}`,
          ).toBe(true);
          expect(result.checks.versionOutput ?? '').not.toBe('');

          expect(result.ok, result.error ?? '').toBe(true);
        } finally {
          await removeContainerQuiet(container);
        }
      },
      PER_AGENT_TIMEOUT_MS + 120_000,
    );
  }

  it(
    'codex half-finished npm bin link: ensureAgentBinaryForSwitch completes the link and the probe passes',
    async () => {
      // The deterministic reproduction of the fleet-1 artifact: npm links a
      // global bin by writing `.<name>-XXXXXXXX` and renaming it onto
      // `<name>`. The box was caught between those two steps — package fully
      // installed, temp link present, real link absent — so every probe said
      // "installed but its binary never appeared on PATH".
      const container = `codeam-agent-install-halflink-${process.pid}`;
      await startContainer(container);
      try {
        // Stage 1 — a real codex install, so the package is genuinely present.
        const install = requireResult(
          'codex',
          'install-probe (half-link setup)',
          await runDriver(container, 'codex', 'install-probe', PER_AGENT_TIMEOUT_MS),
        );
        expect(install.ok, `half-link setup failed: ${install.error ?? ''}`).toBe(true);

        // Stage 2 — break the link, then drive the REAL recovery.
        const result = requireResult(
          'codex',
          'half-link',
          await runDriver(container, 'codex', 'half-link', PER_AGENT_TIMEOUT_MS),
        );

        expect(result.checks.halfLinkStaged, 'could not stage the half-finished link').toBe(true);
        // Non-vacuity: the probe MUST fail while the link is broken.
        expect(
          result.checks.probeFailedWhileLinkBroken,
          'the probe still resolved with the bin link removed — the regression case is vacuous',
        ).toBe(true);
        expect(
          result.checks.ensureOk,
          `ensureAgentBinaryForSwitch did not recover: ${result.checks.ensureError ?? ''}`,
        ).toBe(true);
        expect(result.checks.probeResolvedAfterEnsure, 'probe still blind after recovery').toBe(
          true,
        );
        expect(
          result.checks.versionExitZero,
          `codex --version failed: ${result.checks.versionOutput ?? ''}`,
        ).toBe(true);
        expect(result.ok, result.error ?? '').toBe(true);
      } finally {
        await removeContainerQuiet(container);
      }
    },
    PER_AGENT_TIMEOUT_MS * 2,
  );
});

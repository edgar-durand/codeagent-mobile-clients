/**
 * Self-hosted host-agent — REAL Docker integration test (Phase 3).
 *
 * Design of record:
 *   docs/superpowers/specs/2026-06-17-self-hosted-execution-plane-design.md
 *   ("Testing → Real Docker integration test" — the explicit acceptance gate)
 *
 * This is NOT a unit test. It simulates the USER'S BOX with a real Docker
 * container (Node 20 + the built `codeam-cli`) and runs the real scenario as
 * a real PROCESS TREE — not mocks:
 *
 *   enroll → control channel connects → deploy command received →
 *   supervisor spawns a real `codeam pair-auto` child → child reaches the stub.
 *
 * The stub backend (plain `node:http` + a tiny SSE handler, no Nest) runs on
 * the HOST; the container reaches it via `host.docker.internal`
 * (`--add-host=host.docker.internal:host-gateway` on Linux, native on
 * Docker Desktop). All of the container's outbound traffic is routed to the
 * stub by injecting `CODEAM_API_URL` (resolveApiBaseUrl honors it for the
 * relay, pair-auto claim, and host-client alike).
 *
 * ── Gating ──────────────────────────────────────────────────────────────
 * Skipped UNLESS `DOCKER_E2E=1` is set AND `docker info` succeeds. With the
 * flag absent or Docker unavailable the whole describe self-skips cleanly —
 * the default `npx vitest run` NEVER fails for lack of Docker. CI runs it on
 * a Docker-capable job by setting `DOCKER_E2E=1` (see ci.yml notes); locally
 * it's a manual, Docker-gated gate: `DOCKER_E2E=1 npx vitest run host-agent.docker.e2e`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startStubBackend, type StubBackend } from './docker/stub-backend';

const execFileP = promisify(execFile);

// ── Probe Docker SYNCHRONOUSLY at module load so the describe condition is
// resolved with no top-level await (keeps the file CJS-safe under vitest) ─
const DOCKER_E2E = process.env.DOCKER_E2E === '1';

function probeDockerSync(): boolean {
  if (!DOCKER_E2E) return false;
  try {
    execFileSync('docker', ['info'], { timeout: 15_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dockerReady = probeDockerSync();

const IMAGE_TAG = 'codeam-host-agent-e2e:test';
const CONTAINER_NAME = `codeam-host-agent-e2e-${process.pid}`;
const CLI_DIR = path.resolve(__dirname, '..'); // apps/cli
// Build context = the docker support dir, NOT apps/cli — a tiny, dedicated
// context (Dockerfile + the copied tarball) keeps `docker build` fast and
// cache-friendly instead of streaming the whole apps/cli tree (node_modules,
// dist, all tests) to the daemon.
const DOCKER_DIR = path.join(CLI_DIR, '__tests__', 'docker');
const DOCKERFILE = path.join(DOCKER_DIR, 'host-agent.Dockerfile');

/** Linux daemons need an explicit host-gateway alias; Desktop has it natively. */
function addHostArgs(): string[] {
  return os.platform() === 'linux'
    ? ['--add-host', 'host.docker.internal:host-gateway']
    : [];
}

/** `docker` shell-out with a generous timeout + captured output. */
async function docker(args: string[], timeoutMs = 180_000): Promise<string> {
  const { stdout } = await execFileP('docker', args, {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function removeContainerQuiet(): Promise<void> {
  try {
    await docker(['rm', '-f', CONTAINER_NAME], 30_000);
  } catch {
    /* not running */
  }
}

/** Poll `check` until it returns true or the deadline passes. */
async function waitFor(
  check: () => boolean,
  deadlineMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return check();
}

const suite = dockerReady ? describe : describe.skip;

if (!DOCKER_E2E) {
  // Loud, non-failing breadcrumb so a developer running the default suite
  // understands WHY this gate didn't execute. (Plain console — `log` would
  // route through the CLI logger which is noisy under vitest.)
  // eslint-disable-next-line no-console
  console.log(
    '[host-agent.docker.e2e] SKIPPED — set DOCKER_E2E=1 (and have Docker running) to run the real-container gate.',
  );
} else if (!dockerReady) {
  // eslint-disable-next-line no-console
  console.log(
    '[host-agent.docker.e2e] SKIPPED — DOCKER_E2E=1 but `docker info` failed (daemon unavailable).',
  );
}

suite('host-agent — real Docker integration (Phase 3 acceptance gate)', () => {
  let stub: StubBackend;
  let tarballPath: string;

  // Image build + npm pack are slow; do them once for the suite.
  beforeAll(async () => {
    // 1) Pack the freshly-built CLI so the image installs runtime deps the
    //    bundle leaves external (chokidar, ws, node-pty, …). Requires
    //    `npm run build` to have produced dist/ first (the test asserts it).
    const distIndex = path.join(CLI_DIR, 'dist', 'index.js');
    if (!fs.existsSync(distIndex)) {
      throw new Error(
        `dist/index.js missing — run \`npm run build\` in apps/cli before the Docker E2E.`,
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
    expect(fs.existsSync(packedPath)).toBe(true);

    // Move the tarball into the (tiny) docker build context under a stable
    // name so the Dockerfile's COPY is deterministic + the context stays
    // minimal.
    tarballPath = path.join(DOCKER_DIR, 'codeam-cli.tgz');
    fs.copyFileSync(packedPath, tarballPath);
    fs.unlinkSync(packedPath);

    // 2) Build the image. Build context = the docker support dir.
    await docker([
      'build',
      '-f',
      DOCKERFILE,
      '-t',
      IMAGE_TAG,
      '--build-arg',
      'CODEAM_TARBALL=codeam-cli.tgz',
      DOCKER_DIR,
    ]);

    // 3) The deploy targets an absolute path that EXISTS inside the
    //    container (prepareWorkspace returns it verbatim, no clone). /home/box
    //    is the box user's home — always present.
    stub = await startStubBackend({ repoOrPath: '/home/box', agentId: 'claude_code' });
  }, 240_000);

  afterAll(async () => {
    await removeContainerQuiet();
    if (stub) await stub.close();
    if (tarballPath && fs.existsSync(tarballPath)) {
      try {
        fs.unlinkSync(tarballPath);
      } catch {
        /* best-effort */
      }
    }
  });

  it(
    'enrolls, opens the control channel, receives a deploy, and the spawned child reaches the stub',
    async () => {
      await removeContainerQuiet();

      // Run the container detached. CODEAM_API_URL routes ALL outbound
      // traffic to the stub on the host; CODEAM_ENROLL_TOKEN triggers the
      // first-run redeem; CODEAM_SKIP_AGENT_LAUNCH keeps the child in the
      // infra-only loop (no real Claude binary in the image) — the pair-auto
      // CLAIM is what proves the child reached the backend.
      const apiUrl = `http://host.docker.internal:${stub.port}`;
      await docker([
        'run',
        '-d',
        '--name',
        CONTAINER_NAME,
        ...addHostArgs(),
        '-e',
        `CODEAM_API_URL=${apiUrl}`,
        '-e',
        'CODEAM_ENROLL_TOKEN=enroll-stub-token',
        '-e',
        'CODEAM_SKIP_AGENT_LAUNCH=true',
        // Make sure NODE_ENV is not "test" inside the container — otherwise
        // the relay would skip SSE. (node:20-slim leaves it unset; assert it.)
        '-e',
        'NODE_ENV=production',
        IMAGE_TAG,
      ]);

      // ── Assert the real process tree reached the stub ──────────────────
      // (a) host enrolled (redeem called).
      const enrolled = await waitFor(() => stub.redeemCount() >= 1, 60_000);
      expect(enrolled, 'host-agent should redeem the enroll token').toBe(true);

      // (b) control channel pushed the deploy command (proves SSE connected
      //     on the minted controlPluginId).
      const deployed = await waitFor(() => stub.deployPushed(), 60_000);
      expect(deployed, 'control channel should connect + receive a deploy').toBe(true);

      // (c) at least one liveness heartbeat arrived from the supervisor.
      const beat = await waitFor(() => stub.hostHeartbeatCount() >= 1, 60_000);
      expect(beat, 'host-agent should send a liveness heartbeat').toBe(true);

      // (d) the supervisor unsealed the agent-auth (provisioning step before
      //     spawning the child).
      const unsealed = await waitFor(() => stub.unsealCount() >= 1, 60_000);
      expect(unsealed, 'supervisor should unseal the agent-auth before spawn').toBe(true);

      // (e) THE GATE: the spawned `codeam pair-auto` child performed its
      //     handshake against the stub (claim-auto-token) — i.e. a real child
      //     process spawned by the supervisor connected back to the backend.
      const childPaired = await waitFor(() => stub.pairClaimCount() >= 1, 90_000);
      if (!childPaired) {
        // Surface container logs to make a failure debuggable in CI.
        try {
          const logs = await docker(['logs', CONTAINER_NAME], 30_000);
          // eslint-disable-next-line no-console
          console.error('[host-agent.docker.e2e] container logs:\n' + logs);
        } catch {
          /* ignore */
        }
      }
      expect(
        childPaired,
        'spawned pair-auto child should complete its handshake against the stub',
      ).toBe(true);
    },
    180_000,
  );
});

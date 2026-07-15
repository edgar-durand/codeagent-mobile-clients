/**
 * Fleet control plane — REAL Docker integration test (Phase 2 acceptance gate).
 *
 * Design of record:
 *   docs/superpowers/specs/2026-07-15-fleet-inhouse-selfhosted-rescue-design.md
 *   docs/superpowers/plans/2026-07-15-fleet-p2-clients.md (Task 3)
 *
 * This is NOT a unit test. It builds the REAL `apps/box` image, invokes the
 * REAL `HostAgentSupervisor.handleCommand` fleet handlers (Task 1) against
 * the REAL `docker` binary (no mocked DockerRunner), and asserts — via
 * `docker inspect` on the container `docker run` actually produced — every
 * hard-isolation invariant from the Global Constraints:
 *
 *   cap-drop ALL, no-new-privileges, memory/cpus/pids caps, the `fleet-net`
 *   network, a SINGLE named volume mounted at /home/box (no bind mounts, no
 *   docker.sock), non-root user, and the three `com.codeagent.*` ops labels.
 *
 * It then drives the fleet_stop_box / fleet_start_box / fleet_delete_box
 * lifecycle end to end and confirms delete removes the named volume and is
 * idempotent on an already-gone container.
 *
 * ── Why the DockerRunner is wrapped, not swapped ───────────────────────────
 * The isolation-invariant argv under test is built ENTIRELY by the real
 * `fleetCreateBox` handler — this test never constructs that argv itself.
 * The ONLY thing layered on top is two additions the handler's fixed
 * PRODUCTION template deliberately does not carry (adding them there would
 * be scope creep on the isolation template Task 1 already unit-tests):
 *   - `--add-host host.docker.internal:host-gateway` (Linux only) so the box
 *     can reach the HOST-side stub backend the same way
 *     `host-agent.docker.e2e.test.ts` does — Docker Desktop provides this
 *     alias automatically, only Linux Engine (GitHub Actions) needs it
 *     spelled out. It grants no reachability a container didn't already
 *     have via the bridge gateway; it's a DNS shortcut, not a new capability.
 *   - `-e CODEAM_SKIP_AGENT_LAUNCH=true` (+ `NODE_ENV=production`) so the
 *     stub's auto-pushed `self_hosted_deploy` doesn't try to launch a real
 *     Claude binary the box lacks — mirrors the existing Docker E2E fixture.
 * Both are applied by a thin wrapper AROUND the real `defaultDockerRunner`;
 * every isolation flag, label, and the volume mount still come from the
 * unmodified `fleetCreateBox` argv.
 *
 * ── Integrations-manifest parity — DEFERRED (documented, not silently
 *    skipped) ─────────────────────────────────────────────────────────────
 * The spec's CI wishlist includes asserting `~/.codeam/integrations.json`
 * lands inside a fleet box when the create carries integrations. The wire
 * contract this phase implements (`FleetCreateBoxCommand` in the backend's
 * `fleet.types.ts`, mirrored by `isFleetCreateBoxPayload` in
 * `commands/host-agent.ts`) does NOT carry an `integrations` field — unlike
 * `self_hosted_deploy`'s `DeployPayload`, `fleet_create_box` has no
 * integrations-threading path yet. There's nothing to assert until the
 * backend adds it to the fleet command; wiring it is out of scope for
 * Phase 2 (CLI handlers + the box image + this gate).
 *
 * ── Gating ──────────────────────────────────────────────────────────────
 * Skipped UNLESS `RUN_FLEET_INT=1` AND `docker info` succeeds — mirrors
 * `host-agent.docker.e2e.test.ts`. Locally:
 *   RUN_FLEET_INT=1 npx vitest run fleet-box.int
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HostAgentSupervisor,
  defaultDockerRunner,
  type DockerRunner,
} from '../../src/commands/host-agent';
import type { SealedHostIdentity } from '../../src/commands/host/host-client';
import type { RemoteCommand } from '../../src/services/command-relay.service';
import { startStubBackend, type StubBackend } from '../docker/stub-backend';

const execFileP = promisify(execFile);

// ── Probe Docker SYNCHRONOUSLY at module load so the describe condition is
// resolved with no top-level await (keeps the file CJS-safe under vitest) ─
const RUN_FLEET_INT = process.env.RUN_FLEET_INT === '1';

function probeDockerSync(): boolean {
  if (!RUN_FLEET_INT) return false;
  try {
    execFileSync('docker', ['info'], { timeout: 15_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dockerReady = probeDockerSync();

const CLI_DIR = path.resolve(__dirname, '..', '..'); // apps/cli
const BOX_DIR = path.resolve(CLI_DIR, '..', 'box'); // apps/box
const FLEET_NETWORK = 'fleet-net';
const CONTAINER_NAME = `codeam-box-int${process.pid}`;
const IDENTITY: SealedHostIdentity = {
  hostId: 'fleet-int-host',
  hostToken: 'fleet-int-token',
  controlPluginId: 'fleet-int-control',
};

/** Linux daemons need an explicit host-gateway alias; Docker Desktop has it natively. */
function addHostArgs(): string[] {
  return os.platform() === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : [];
}

/** `docker` shell-out with a generous timeout + captured output. */
async function docker(args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileP('docker', args, {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function inspectContainer(name: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await docker(['inspect', name]);
    const [info] = JSON.parse(raw) as Array<Record<string, unknown>>;
    return info ?? null;
  } catch {
    return null;
  }
}

async function volumeExists(name: string): Promise<boolean> {
  try {
    await docker(['volume', 'inspect', name]);
    return true;
  } catch {
    return false;
  }
}

async function removeContainerQuiet(): Promise<void> {
  try {
    await docker(['rm', '-f', CONTAINER_NAME], 30_000);
  } catch {
    /* not running */
  }
}

async function removeVolumeQuiet(): Promise<void> {
  try {
    await docker(['volume', 'rm', '-f', CONTAINER_NAME], 30_000);
  } catch {
    /* already gone */
  }
}

/** Poll `check` until it returns true or the deadline passes. */
async function waitFor(
  check: () => boolean | Promise<boolean>,
  deadlineMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return check();
}

/**
 * Wraps the REAL `defaultDockerRunner` — every isolation flag, label, and
 * mount in the argv under test comes unmodified from the real
 * `fleetCreateBox` handler. This only ADDS the two CI-connectivity args
 * documented at the top of the file, and only to `docker run` invocations.
 */
function ciDockerRunner(): DockerRunner {
  return {
    run(args, opts) {
      if (args[0] !== 'run') return defaultDockerRunner.run(args, opts);
      const withCiArgs = [
        args[0],
        ...addHostArgs(),
        '-e',
        'CODEAM_SKIP_AGENT_LAUNCH=true',
        '-e',
        'NODE_ENV=production',
        ...args.slice(1),
      ];
      return defaultDockerRunner.run(withCiArgs, opts);
    },
  };
}

function fleetRefCmd(type: string, over: Partial<Record<string, unknown>> = {}): RemoteCommand {
  return {
    id: `cmd-${type}`,
    sessionId: IDENTITY.controlPluginId,
    type,
    payload: { boxId: 'box-int-1', containerName: CONTAINER_NAME, ...over },
  };
}

const suite = dockerReady ? describe : describe.skip;

if (!RUN_FLEET_INT) {
  // eslint-disable-next-line no-console
  console.log(
    '[fleet-box.int] SKIPPED — set RUN_FLEET_INT=1 (and have Docker running) to run the real-container gate.',
  );
} else if (!dockerReady) {
  // eslint-disable-next-line no-console
  console.log(
    '[fleet-box.int] SKIPPED — RUN_FLEET_INT=1 but `docker info` failed (daemon unavailable).',
  );
}

suite('fleet control plane — real Docker integration (Phase 2 acceptance gate)', () => {
  let stub: StubBackend;

  beforeAll(async () => {
    // The isolated bridge network the box joins. Idempotent — mirrors
    // infra/fleet/setup-vps.sh's one-shot bring-up on the real fleet VPS.
    try {
      await docker(['network', 'inspect', FLEET_NETWORK], 15_000);
    } catch {
      await docker(
        [
          'network',
          'create',
          '--opt',
          'com.docker.network.bridge.enable_icc=false',
          FLEET_NETWORK,
        ],
        30_000,
      );
    }

    // Build the real production box image (or reuse a pre-built tag —
    // FLEET_BOX_IMAGE_TAG lets CI build it once in an earlier step and skip
    // a redundant build here).
    const imageTag = process.env.FLEET_BOX_IMAGE_TAG || `codeam-box-fleet-int:${process.pid}`;
    if (!process.env.FLEET_BOX_IMAGE_TAG) {
      await docker(['build', '-t', imageTag, BOX_DIR], 300_000);
    }
    // fleetCreateBox resolves the image from this env var (host-side config,
    // never read from the wire — see resolveFleetBoxImage in host-agent.ts).
    process.env.CODEAM_FLEET_BOX_IMAGE = imageTag;

    stub = await startStubBackend({ repoOrPath: '/home/box', agentId: 'claude_code' });
  }, 360_000);

  afterAll(async () => {
    await removeContainerQuiet();
    await removeVolumeQuiet();
    if (stub) await stub.close();
    if (!process.env.FLEET_BOX_IMAGE_TAG) {
      try {
        await docker(['rmi', '-f', `codeam-box-fleet-int:${process.pid}`], 30_000);
      } catch {
        /* best-effort */
      }
    }
    delete process.env.CODEAM_FLEET_BOX_IMAGE;
  });

  it(
    'fleet_create_box → every isolation invariant + ops label holds, the entrypoint redeems, ' +
      'and the stop/start/delete lifecycle round-trips (delete removes the volume, is idempotent)',
    async () => {
      await removeContainerQuiet();
      await removeVolumeQuiet();

      const sup = new HostAgentSupervisor(IDENTITY, { docker: ciDockerRunner() });
      const boxId = 'box-int-1';
      const apiOrigin = `http://host.docker.internal:${stub.port}`;

      // ── fleet_create_box: the REAL handler builds the FULL argv ────────
      await sup.handleCommand({
        id: 'cmd-create',
        sessionId: IDENTITY.controlPluginId,
        type: 'fleet_create_box',
        payload: {
          boxId,
          containerName: CONTAINER_NAME,
          enrollToken: 'enroll-stub-token',
          apiOrigin,
          limits: { memoryMb: 512, cpus: 1, pidsLimit: 256, diskGb: 5 },
        },
      });

      const created = await inspectContainer(CONTAINER_NAME);
      expect(created, 'fleet_create_box should produce an inspectable container').not.toBeNull();
      const info = created as {
        Config: { User: string; Labels: Record<string, string> };
        HostConfig: {
          CapDrop: string[];
          SecurityOpt: string[];
          Memory: number;
          NanoCpus: number;
          PidsLimit: number;
          NetworkMode: string;
          Privileged: boolean;
        };
        Mounts: Array<{ Type: string; Name?: string; Destination: string; Source: string }>;
      };

      // Hard isolation invariants (Global Constraints).
      expect(info.HostConfig.CapDrop).toContain('ALL');
      expect(info.HostConfig.SecurityOpt.some((s) => s.includes('no-new-privileges'))).toBe(true);
      expect(info.HostConfig.Memory).toBe(512 * 1024 * 1024);
      expect(info.HostConfig.NanoCpus).toBe(1_000_000_000);
      expect(info.HostConfig.PidsLimit).toBe(256);
      expect(info.HostConfig.NetworkMode).toBe(FLEET_NETWORK);
      expect(info.HostConfig.Privileged).toBe(false);

      // Non-root user (from the image, not an explicit --user flag).
      expect(info.Config.User).toBe('box');

      // Ops labels.
      const expectedUserId = CONTAINER_NAME.slice('codeam-box-'.length);
      expect(info.Config.Labels['com.codeagent.user-id']).toBe(expectedUserId);
      expect(info.Config.Labels['com.codeagent.box-id']).toBe(boxId);
      expect(info.Config.Labels['com.codeagent.created-by']).toBe('fleet');

      // The ONLY mount is the named volume at /home/box — no bind mounts,
      // no docker.sock.
      expect(info.Mounts).toHaveLength(1);
      expect(info.Mounts[0].Type).toBe('volume');
      expect(info.Mounts[0].Name).toBe(CONTAINER_NAME);
      expect(info.Mounts[0].Destination).toBe('/home/box');
      expect(JSON.stringify(info.Mounts)).not.toContain('docker.sock');

      // ── The entrypoint redeems the enroll token against the stub ───────
      const redeemed = await waitFor(() => stub.redeemCount() >= 1, 60_000);
      expect(redeemed, 'the box entrypoint should redeem CODEAM_ENROLL_TOKEN').toBe(true);

      // ── fleet_stop_box ───────────────────────────────────────────────
      await sup.handleCommand(fleetRefCmd('fleet_stop_box'));
      const stopped = await waitFor(async () => {
        const c = await inspectContainer(CONTAINER_NAME);
        return c !== null && (c as { State: { Running: boolean } }).State.Running === false;
      }, 30_000);
      expect(stopped, 'fleet_stop_box should stop the container').toBe(true);

      // ── fleet_start_box ──────────────────────────────────────────────
      await sup.handleCommand(fleetRefCmd('fleet_start_box'));
      const started = await waitFor(async () => {
        const c = await inspectContainer(CONTAINER_NAME);
        return c !== null && (c as { State: { Running: boolean } }).State.Running === true;
      }, 30_000);
      expect(started, 'fleet_start_box should restart the container').toBe(true);

      // ── fleet_delete_box (removeVolume) — removes container + volume ──
      await sup.handleCommand(fleetRefCmd('fleet_delete_box', { removeVolume: true }));
      const containerGone = await waitFor(
        async () => (await inspectContainer(CONTAINER_NAME)) === null,
        30_000,
      );
      expect(containerGone, 'fleet_delete_box should remove the container').toBe(true);
      const volumeGone = await waitFor(async () => !(await volumeExists(CONTAINER_NAME)), 30_000);
      expect(volumeGone, 'fleet_delete_box(removeVolume) should remove the named volume').toBe(
        true,
      );

      // ── Idempotency: deleting an already-gone box is SUCCESS ──────────
      await expect(
        sup.handleCommand(fleetRefCmd('fleet_delete_box', { removeVolume: true })),
      ).resolves.toBeUndefined();
      // ...and stopping an already-gone box is likewise a no-throw no-op.
      await expect(sup.handleCommand(fleetRefCmd('fleet_stop_box'))).resolves.toBeUndefined();
    },
    240_000,
  );
});

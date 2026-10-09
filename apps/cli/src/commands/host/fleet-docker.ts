/**
 * Fleet control plane (CodeAgent Box rescue fleet) — the PURE half of the
 * `fleet_*` handlers in `host-agent.ts`: wire-payload guards, the `docker run`
 * isolation template, and the injectable {@link DockerRunner}. The handlers
 * themselves (which own supervisor state and progress reporting) stay on
 * `HostAgentSupervisor`. Extracted from host-agent.ts with no behavior change
 * (god-file decomposition, epic codeagent-2sa).
 */

import { spawn } from 'node:child_process';
import type { RemoteCommand } from '../../services/command-relay.service';
import { killQuiet } from '../../lib/quiet';

// ── Fleet control plane (CodeAgent Box rescue fleet) ───────────────────────
//
// Design of record: docs/superpowers/specs/2026-07-15-fleet-inhouse-selfhosted-rescue-design.md
//
// The fleet host is an ordinary self-hosted `codeam host-agent` (enrolled
// once as a host of our own system account) that ALSO understands four
// additive command types pushed down the SAME control channel:
//
//   fleet_create_box  → `docker run` a per-user rescue box
//   fleet_start_box   → `docker start` (wake a sleeping box)
//   fleet_stop_box    → `docker stop`  (sleep an idle box)
//   fleet_delete_box  → `docker rm -f` (+ optional volume rm on reap)
//
// A normal self-hosted box never receives these — they're only ever pushed
// to the ONE host enrolled as `FLEET_HOST_ID` on the backend. Payload shapes
// mirror the backend's `fleet.types.ts` EXACTLY (`FleetCreateBoxCommand` /
// `FleetBoxRefCommand`) — same hand-rolled-guard precedent as `DeployPayload`
// in `host-agent.ts`, deliberately NOT hoisted into `@codeam/shared`.

/** The `fleet_create_box` payload (mirrors backend `FleetCreateBoxCommand`). */
export interface FleetCreateBoxPayload {
  boxId: string;
  containerName: string;
  /** Single-use self-hosted enroll token minted for the RESCUED USER — the
   *  box's `codeam host-agent` entrypoint redeems it on boot. Delivered to
   *  the container via `-e`; NEVER logged. */
  enrollToken: string;
  apiOrigin: string;
  limits: {
    memoryMb: number;
    cpus: number;
    pidsLimit: number;
    /** Not enforceable by `docker run` directly (no first-class disk-quota
     *  flag portable across storage drivers) — documented, not wired into
     *  argv. The named volume itself is capped at the infra layer. */
    diskGb: number;
  };
}

/**
 * `fleet_migrate_box_image` — re-point a SLEEPING box at the current `:latest`
 * WITHOUT waking it. Backend shape: `FleetMigrateBoxImageCommand`.
 *
 * Deliberately has NO `enrollToken`, which is the difference that makes this
 * safe to apply in a batch. See `fleetMigrateBoxImage`.
 */
export interface FleetMigrateBoxImagePayload {
  boxId: string;
  containerName: string;
  limits: FleetCreateBoxPayload['limits'];
  apiOrigin: string;
}

/** The `fleet_start_box` / `fleet_stop_box` / `fleet_delete_box` payload
 *  (mirrors backend `FleetBoxRefCommand`). */
export interface FleetBoxRefPayload {
  boxId: string;
  containerName: string;
  /** delete only: also remove the named volume (reap). */
  removeVolume?: boolean;
  /**
   * start (wake) only — the recreate credentials. When the backend includes a
   * FRESH enroll token + api origin + limits, `fleet_start_box` can RECREATE
   * the container from the current `:latest` image (not just `docker start` the
   * stale one) so a box never stays pinned to an old runtime. The box's sealed
   * volume (workspace) is preserved; a fresh token makes `resolveHostIdentity`
   * re-redeem → the box picks up any control-channel changes (e.g. the poll
   * secret) that the old sealed identity lacked. Absent on an older backend →
   * the handler falls back to a plain `docker start` (fully back-compatible).
   */
  enrollToken?: string;
  apiOrigin?: string;
  limits?: FleetCreateBoxPayload['limits'];
}

/**
 * Container-name allowlist. The backend derives `codeam-box-<userId>`
 * (cuids are `[a-z0-9]`, already docker-name-safe) and — per the Global
 * Constraints — the SAME string also names the box's named volume. Refusing
 * anything else means this handler can never be steered into touching a
 * non-fleet container/volume on the shared host.
 */
const FLEET_CONTAINER_NAME_RE = /^codeam-box-[a-z0-9]+$/;

export function isFleetContainerName(v: unknown): v is string {
  return typeof v === 'string' && FLEET_CONTAINER_NAME_RE.test(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isFleetLimits(v: unknown): v is FleetCreateBoxPayload['limits'] {
  if (typeof v !== 'object' || v === null) return false;
  const l = v as Record<string, unknown>;
  return (
    isFiniteNumber(l.memoryMb) &&
    isFiniteNumber(l.cpus) &&
    isFiniteNumber(l.pidsLimit) &&
    isFiniteNumber(l.diskGb)
  );
}

export function isFleetCreateBoxPayload(
  p: Record<string, unknown>,
): p is FleetCreateBoxPayload & Record<string, unknown> {
  return (
    typeof p.boxId === 'string' &&
    isFleetContainerName(p.containerName) &&
    typeof p.enrollToken === 'string' &&
    p.enrollToken.length > 0 &&
    typeof p.apiOrigin === 'string' &&
    p.apiOrigin.length > 0 &&
    isFleetLimits(p.limits)
  );
}

export function isFleetMigrateBoxImagePayload(
  p: Record<string, unknown>,
): p is FleetMigrateBoxImagePayload & Record<string, unknown> {
  return (
    typeof p.boxId === 'string' &&
    isFleetContainerName(p.containerName) &&
    typeof p.apiOrigin === 'string' &&
    p.apiOrigin.length > 0 &&
    isFleetLimits(p.limits) &&
    // ⚠️ REJECT a token outright rather than ignoring it. A migrate that
    // carried one would bake a 15-minute credential into a container that may
    // not start for days — a terminal 4xx at boot, i.e. a box that never comes
    // back. If a future backend starts sending one, this must fail loudly here
    // rather than silently produce that box.
    p.enrollToken === undefined
  );
}

export function isFleetBoxRefPayload(
  p: Record<string, unknown>,
): p is FleetBoxRefPayload & Record<string, unknown> {
  if (typeof p.boxId !== 'string') return false;
  if (!isFleetContainerName(p.containerName)) return false;
  if (p.removeVolume !== undefined && typeof p.removeVolume !== 'boolean') return false;
  // Optional recreate credentials (start/wake). Validate ONLY if present — a
  // plain wake omits them and falls back to `docker start`.
  if (p.enrollToken !== undefined && (typeof p.enrollToken !== 'string' || !p.enrollToken)) {
    return false;
  }
  if (p.apiOrigin !== undefined && (typeof p.apiOrigin !== 'string' || !p.apiOrigin)) return false;
  if (p.limits !== undefined && !isFleetLimits(p.limits)) return false;
  return true;
}

/** True when a start payload carries everything needed to RECREATE the box
 *  (fresh token + api origin + limits), not just wake the existing container. */
export function fleetRefCanRecreate(
  p: FleetBoxRefPayload,
): p is FleetBoxRefPayload &
  Required<Pick<FleetBoxRefPayload, 'enrollToken' | 'apiOrigin' | 'limits'>> {
  return (
    typeof p.enrollToken === 'string' &&
    p.enrollToken.length > 0 &&
    typeof p.apiOrigin === 'string' &&
    p.apiOrigin.length > 0 &&
    p.limits !== undefined
  );
}

/** `codeam-box-<userId>` → `<userId>`. Only called after {@link isFleetContainerName}
 *  has validated the shape, so the slice is always well-formed. */
function fleetUserIdFromContainerName(containerName: string): string {
  return containerName.slice('codeam-box-'.length);
}

/** `docker stop` / `docker rm` on an already-gone container exit non-zero
 *  with this stderr — the fleet handlers treat that as SUCCESS (idempotent:
 *  the backend's reap sweeps may re-send a stop/delete for a box the host
 *  already cleaned up). */
export function isMissingContainerError(stderr: string): boolean {
  return /no such container/i.test(stderr);
}

/**
 * The lane a fleet command runs on: its container, so one box's ops stay in
 * order, or the host itself for a prune. `null` for anything that is not a
 * fleet command. A malformed payload still gets a lane (keyed by type) so the
 * handler can reject it the usual way.
 */
export function fleetLaneKey(cmd: RemoteCommand): string | null {
  if (!cmd.type.startsWith('fleet_')) return null;
  if (cmd.type === 'fleet_prune_host') return 'host';
  const payload = cmd.payload as { containerName?: unknown } | undefined;
  return typeof payload?.containerName === 'string' ? payload.containerName : cmd.type;
}

/**
 * The `fleet_prune_host` payload (mirrors backend `FleetPruneHostCommand`).
 *
 * Host disk housekeeping. Nothing reclaimed Docker's residue on the shared VPS,
 * so it grew until the provider warned at 83% (160 GB of 193 used;
 * `/var/lib/containerd` alone 138 GB, because every `docker run --pull=always`
 * of a new `codeam-box:latest` orphans the previous image). One prune freed
 * 93.8 GB.
 *
 * ⚠️ THE SCOPE IS THE SAFETY PROPERTY. This handler runs as root on a host that
 * holds every rescued user's data, so it does exactly three things and refuses
 * to be steered anywhere else:
 *   - superseded BOX images, by tag (`images`): keep the current `:latest` plus
 *     one previous release (tagged `:rollback`), `docker rmi` the other Box tags
 *     no container references. Never `-f`, never a non-Box name. See
 *     `host/fleet-image-gc.ts`.
 *   - `docker image prune` — DANGLING ONLY, never `-a`. Safe because Docker
 *     refuses to delete an image any container references, INCLUDING stopped
 *     ones.
 *   - `docker builder prune --all --filter until=72h` — pure derived data. The
 *     host pulls its images and builds nothing, and a bare `builder prune` only
 *     drops DANGLING cache: fleet-1 kept 9.97 GB of two-month-old cache through
 *     a month of daily "builder ok" runs (2026-10-02).
 * It must NEVER prune containers or volumes, no matter what the wire says:
 *   - a STOPPED fleet container IS A SLEEPING BOX (the wake path `docker start`s
 *     it), so `docker container prune` would destroy every sleeping user's box;
 *   - a box's named volume holds the user's workspace + sealed identity and
 *     deliberately OUTLIVES its container (the reap sweep removes it explicitly,
 *     and post-mortem debugging reads it), so `docker volume prune` — which
 *     removes any volume no container currently uses — would delete exactly the
 *     data we keep on purpose.
 * The flags are read but can only ever SUBTRACT from that fixed set.
 */
export interface FleetPruneHostPayload {
  images: boolean;
  buildCache: boolean;
}

export function isFleetPruneHostPayload(v: unknown): v is FleetPruneHostPayload {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.images === 'boolean' && typeof p.buildCache === 'boolean';
}

/** Same idempotency treatment for `docker volume rm` on reap. */
export function isMissingVolumeError(stderr: string): boolean {
  return /no such volume/i.test(stderr);
}

/**
 * Resolve the box image the fleet host runs. Host-side config, NEVER read
 * from the wire (the wire payload carries no image field — see
 * `FleetCreateBoxCommand`). Overridable with `CODEAM_FLEET_BOX_IMAGE` (the
 * real-Docker CI int test points this at its freshly-built local tag).
 */
export function resolveFleetBoxImage(): string {
  return process.env.CODEAM_FLEET_BOX_IMAGE || 'ghcr.io/edgar-durand/codeam-box:latest';
}

/**
 * Args for the sleeping-box image migration: `docker create`, not `run`.
 *
 * Built by rewriting the create args so the container gets the IDENTICAL
 * caps/limits/mounts a real box has — a hand-rolled second arg list would
 * drift from `buildFleetBoxRunArgs` the first time a security flag changes,
 * and the drift would only show up as a box that behaves subtly differently
 * after it wakes.
 *
 * Two substitutions, both load-bearing:
 *   · `run` → `create`: binds the container to the new image and leaves it
 *     STOPPED, so the box stays asleep. `run` would start it, and migrating a
 *     batch would wake every sleeping box at once (on fleet-1 that is
 *     9 × 1536 MB against 16 GB) only for the sleep sweep to re-sleep them.
 *   · `--pull=always` is DROPPED. The backend dispatches this right after the
 *     wake path has already pulled, and more importantly a create must not sit
 *     inside a registry round-trip per box; the pull happens once, explicitly,
 *     before the loop.
 */
export function buildFleetBoxMigrateArgs(p: {
  boxId: string;
  containerName: string;
  apiOrigin: string;
  limits: FleetCreateBoxPayload['limits'];
}): string[] {
  return buildFleetBoxRunArgs(p)
    .map((a) => (a === 'run' ? 'create' : a))
    .filter((a) => a !== '--pull=always' && a !== '-d');
}

/**
 * Build the FULL `docker run` argv for a fleet box — the SINGLE source of the
 * isolation template, shared by `fleet_create_box` AND the wake-recreate path
 * (`fleet_start_box` when the container's image is stale). Nothing from the wire
 * flows through as a raw docker arg beyond the already-validated containerName +
 * numeric limits. The enroll token is delivered via `DockerRunner.run`'s
 * `opts.env` (a bare `-e CODEAM_ENROLL_TOKEN`), NEVER argv → never visible in
 * `ps` on the shared host, never logged.
 */
export function buildFleetBoxRunArgs(p: {
  boxId: string;
  containerName: string;
  apiOrigin: string;
  limits: FleetCreateBoxPayload['limits'];
}): string[] {
  const userId = fleetUserIdFromContainerName(p.containerName);
  const image = resolveFleetBoxImage();
  return [
    'run',
    '-d',
    // Registry-default image: always pull so the box never silently runs this
    // host's STALE cached :latest. An explicit CODEAM_FLEET_BOX_IMAGE override
    // (int test / operator) keeps docker's default policy — a local-only tag
    // can't be pulled.
    ...(process.env.CODEAM_FLEET_BOX_IMAGE ? [] : ['--pull=always']),
    '--name',
    p.containerName,
    // The box's host-agent is the container's pid 1 and its self-update restart
    // is an exit(0): without a restart policy that stopped the whole box until
    // the next wake. `docker stop` (the sleep sweep) still keeps it stopped.
    '--restart',
    'unless-stopped',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    `${p.limits.memoryMb}m`,
    '--cpus',
    String(p.limits.cpus),
    '--pids-limit',
    String(p.limits.pidsLimit),
    '--network',
    'fleet-net',
    '--label',
    `com.codeagent.user-id=${userId}`,
    '--label',
    `com.codeagent.box-id=${p.boxId}`,
    '--label',
    'com.codeagent.created-by=fleet',
    '-v',
    `${p.containerName}:/home/box`,
    // Bare `-e NAME` — docker reads the value from ITS OWN process env (supplied
    // via opts.env), never from this argv.
    '-e',
    'CODEAM_ENROLL_TOKEN',
    '-e',
    `CODEAM_API_URL=${p.apiOrigin}`,
    // User-facing "My Servers" label; read at redeem via resolveHostLabel.
    '-e',
    'CODEAM_HOST_LABEL=CodeAgent Box',
    // The enroll token is single-use but lives in the container's fixed env;
    // resolveHostIdentity resumes from the sealed identity on a terminal
    // enroll-token rejection (a plain wake/restart replaying the consumed
    // token). Kept for observability / older-CLI back-compat.
    '-e',
    'CODEAM_ENROLL_EPHEMERAL=1',
    image,
  ];
}

/**
 * Subprocess runner injectable for the fleet `docker` control-plane
 * handlers. Mirrors {@link OsRunner} (`commands/host/os-packages.ts`):
 * `run` resolves — never rejects — with `{code, stderr, stdout}`; `stdout`
 * is needed to capture the created container id off `docker run -d`. Argv
 * arrays only — the default runner NEVER shells through `sh -c`.
 */
export interface DockerRunner {
  run(
    args: string[],
    opts?: {
      timeoutMs?: number;
      /**
       * Extra env vars for the `docker` CLI process itself — NOT for the
       * container. This is how a bare `-e NAME` (no `=value`) in `args`
       * gets its value: docker reads it from ITS OWN process env and
       * forwards it into the container. Merged OVER `process.env` (never
       * replaces it — PATH etc. must survive), so secrets never touch argv
       * (visible via `ps`) while still reaching the container.
       */
      env?: Record<string, string>;
    },
  ): Promise<{ code: number | null; stderr: string; stdout: string }>;
}

/** Advisory bound for a fast fleet `docker` invocation (rm/stop/start/inspect). */
export const DOCKER_RUN_TIMEOUT_MS = 120_000;

/**
 * Bound for a fleet `docker run` that PULLS the box image inline (`--pull=always`).
 * A cold pull of the ~1 GB codeam-box image on a shared host regularly exceeds
 * the 120 s fast bound → the runner SIGTERM'd the `docker run` mid-pull
 * ("Download complete" then killed, code=143) → the box never enrolled →
 * PROVISIONING-timeout → FAILED (observed 2026-08-08, the recurring failed
 * creates). 10 min gives a cold pull generous headroom while staying under the
 * backend's 15-min provisioning-timeout sweep so a genuinely wedged run still
 * gets reaped. Applies ONLY to the create + wake-recreate runs (the ones that
 * pull); rm/stop/start stay on the fast bound.
 */
export const DOCKER_RUN_WITH_PULL_TIMEOUT_MS = 600_000;

/**
 * Bound for the `fleet_prune_host` steps. Deleting multi-GB images under the
 * containerd snapshotter outlasts the 120 s fast bound, and a killed prune
 * reclaims nothing (fleet-1, 2026-10-02: code=143 every day).
 */
export const DOCKER_PRUNE_TIMEOUT_MS = 600_000;

/** Default runner: spawn the real `docker` binary (argv only, no shell). */
export const defaultDockerRunner: DockerRunner = {
  run(args, opts = {}): Promise<{ code: number | null; stderr: string; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn('docker', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...opts.env },
      });
      let stdoutBuf = '';
      let stderrBuf = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        killQuiet(child);
      }, opts.timeoutMs ?? DOCKER_RUN_TIMEOUT_MS);
      const done = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stderr: stderrBuf, stdout: stdoutBuf });
      };
      child.stdout?.on('data', (b: Buffer) => {
        stdoutBuf += b.toString();
      });
      child.stderr?.on('data', (b: Buffer) => {
        stderrBuf += b.toString();
      });
      child.once('error', (err) => {
        stderrBuf += stderrBuf ? `\n${err.message}` : err.message;
        done(null);
      });
      child.once('exit', (code) => done(code));
    });
  },
};

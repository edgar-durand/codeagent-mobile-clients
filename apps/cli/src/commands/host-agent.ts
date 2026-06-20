/**
 * `codeam host-agent` — self-hosted execution-plane supervisor.
 *
 * Design of record:
 * docs/superpowers/specs/2026-06-17-self-hosted-execution-plane-design.md
 *
 * Runs (under systemd) on the user's own Linux box. It is a thin
 * SUPERVISOR — it never touches the session layer:
 *
 *   1. Loads the sealed host identity (`~/.codeam/host-agent.json`), or
 *      redeems the `CODEAM_ENROLL_TOKEN` on first run and seals it.
 *   2. Opens ONE outbound control channel by REUSING the existing
 *      `CommandRelayService` (the same SSE-pull relay a normal session
 *      uses), subscribed on the host's `controlPluginId`. No new poll
 *      loop — control commands arrive over the relay; the only timer is
 *      a liveness heartbeat to `POST /api/self-hosted/heartbeat`.
 *   3. On `self_hosted_deploy`: prepares the workspace, writes the agent
 *      credential the SAME way a codespace does, and spawns
 *      `codeam pair-auto` as a supervised CHILD carrying
 *      `CODEAM_AUTO_TOKEN`. The child pairs back exactly like a codespace
 *      session — we add a supervisor, we do not reimplement pairing.
 *   4. On `self_hosted_stop { sessionId }`: kills the matching child.
 *
 * Reboot survival is systemd's job (it restarts this process); we re-open
 * the channel from the sealed token. Children are NOT auto-resumed (v1).
 *
 * ── Phase-3 / backend gap to close the loop ──────────────────────────
 * The deploy command's `sealedAgentAuth` is sealed with the backend's
 * vault key (HKDF from SECRETS_ROOT_KEY, server-side ONLY). The box holds
 * no decryption key — by design (no key custody). So turning the sealed
 * blob into a written credential requires an outbound,
 * host-token-authenticated `POST /api/self-hosted/unseal-agent-auth`
 * round-trip (see host-client.ts `unsealAgentAuth`). That endpoint is the
 * one backend change still needed to run the real Docker E2E (Phase 3).
 * Everything else here is complete + tested via an injected resolver.
 */

import { execFileSync, execFile, spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import { CommandRelayService, type RemoteCommand } from '../services/command-relay.service';
import type { AgentMetadata } from '@codeagent/shared';
import { resolveApiBaseUrl } from '@codeagent/shared';
import { log } from '../services/logger';
import {
  deleteHostIdentity,
  isHostAuthRejection,
  loadHostIdentity,
  MetricsCollector,
  redeemEnrollToken,
  reportDeployProgress,
  reportProgress,
  saveHostIdentity,
  sendHostHeartbeat,
  unsealAgentAuth,
  type AgentAuthResolver,
  type HostMetrics,
  type SealedHostIdentity,
} from './host/host-client';
import { isAbsolutePathTarget, prepareWorkspace } from './host/workspace';
import { provisionAgentCredentials } from './host/agent-provisioning';
import { HeadroomStatsReporter, type Savings, type StatsShape } from '../services/headroom/stats-reporter';

/** Liveness heartbeat cadence. State liveness only — NOT command polling. */
const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Context the Headroom reporter needs to authenticate its savings POST.
 * Mirrors the codespace session's auth fields; callers supply real values
 * from the claimed session (pair-auto) or the deploy payload (self-hosted).
 */
export interface HeadroomReporterCtx {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  codespaceId: string;
}

/**
 * Start a {@link HeadroomStatsReporter} scoped to the running codespace
 * agent session, or return `null` when the feature is disabled.
 *
 * Enabled only when `HEADROOM_ENABLED === '1'` (injected by the backend
 * bootstrap for PRO users whose plan has Headroom + the kill-switch is off).
 *
 * Never throws into the agent launch path — construction and `start()` are
 * wrapped in a try/catch so a misconfigured or unavailable Headroom proxy
 * can't prevent the session from starting.
 *
 * URL resolution order for the savings POST target:
 *   1. `HEADROOM_SAVINGS_INGEST_URL` (full URL, exported by the backend into
 *      the codespace env — preferred, avoids a round-trip resolution).
 *   2. Constructed from `resolveApiBaseUrl()` as the fallback:
 *      `${apiBase}/api/codespaces/${ctx.codespaceId}/headroom-savings`
 */
export function maybeStartHeadroomReporter(
  ctx: HeadroomReporterCtx,
): HeadroomStatsReporter | null {
  if (process.env['HEADROOM_ENABLED'] !== '1') return null;

  try {
    const ingestUrl =
      process.env['HEADROOM_SAVINGS_INGEST_URL'] ??
      `${resolveApiBaseUrl()}/api/codespaces/${ctx.codespaceId}/headroom-savings`;

    const reporter = new HeadroomStatsReporter({
      fetchStats: async () => {
        const res = await fetch('http://localhost:8787/stats');
        // res.json() returns unknown; cast at this validated boundary.
        return res.json() as Promise<StatsShape>;
      },
      postSavings: async (delta: Savings) => {
        await fetch(ingestUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Plugin-Auth-Token': ctx.pluginAuthToken,
          },
          body: JSON.stringify({
            sessionId: ctx.sessionId,
            pluginId: ctx.pluginId,
            agentId: process.env['HEADROOM_AGENT'] ?? 'claude',
            savings: delta,
          }),
        });
      },
    });
    reporter.start();
    return reporter;
  } catch (err) {
    log.warn('headroom', `failed to start Headroom reporter (best-effort): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * The managed "CodeAgent Cloud" house-agent proxy block (mirrors the
 * backend `SelfHostedHouseProxy`). When present, the child runs the
 * underlying agent pointed at our managed proxy with NO user
 * credentials — exactly like the codespace house bootstrap.
 */
interface HouseProxy {
  baseUrl: string;
  token: string;
  agentKind: string;
}

/** The deploy command payload (mirrors the backend `SelfHostedDeployCommand`). */
interface DeployPayload {
  deployId: string;
  repoOrPath: string;
  agentId: string;
  /** Sealed LinkedAgent credential. Present iff NOT a house-agent deploy. */
  sealedAgentAuth?: string;
  /** Managed house-agent proxy config. Present iff a house-agent deploy. */
  houseProxy?: HouseProxy;
  autoPairToken: string;
  /**
   * Short-lived GitHub token for cloning the target repo. Present when the
   * box must clone a (possibly private) GitHub repo it can't read with its
   * own ambient git auth. Absent for absolute-path deploys or when the box
   * is trusted to clone on its own. NEVER logged.
   */
  cloneToken?: string;
  /**
   * Shell that installs the selected agent's CLI (from the backend's
   * per-agent provisioning strategy — same one the codespace bootstrap
   * runs). Executed before spawning so the agent binary is on PATH for
   * anything that shells out to it, notably `claude -p` / `codex` preview
   * detection. Best-effort: a failed install doesn't block the deploy —
   * the chat agent runs via the bundled ACP SDK regardless.
   */
  agentInstallScript?: string;
  /**
   * Cloudflare named-tunnel token for the in-app Preview. When present it's
   * exported into the child env as `PREVIEW_TUNNEL_TOKEN` so the preview
   * runs `cloudflared tunnel run` against a stable
   * `*.preview.codeagent-mobile.com` hostname instead of the
   * intermittently-resolved `*.trycloudflare.com`. Absent → quick-tunnel
   * fallback. NEVER logged.
   */
  previewTunnelToken?: string;
  /** Stable preview hostname for this box's tunnel; exported as `PREVIEW_TUNNEL_HOSTNAME`. */
  previewHostname?: string;
  /**
   * When true, set up the Headroom local compression proxy before spawning
   * the pair-auto child and inject HEADROOM_* env vars so the child's
   * maybeStartHeadroomReporter activates. Best-effort — a failed or absent
   * Headroom install must NEVER block the deploy. Absent = false.
   */
  headroomEnabled?: boolean;
  /**
   * Agent identifier passed to `headroom init --global <agent>`.
   * e.g. 'claude'. Required when headroomEnabled is true.
   */
  headroomAgent?: string;
  /**
   * Full ingest URL for the Headroom savings reporter (POST target).
   * Required when headroomEnabled is true.
   */
  headroomSavingsIngestUrl?: string;
}

/** The stop command payload (mirrors the backend `SelfHostedStopCommand`). */
interface StopPayload {
  sessionId: string;
}

function isHouseProxy(v: unknown): v is HouseProxy {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.baseUrl === 'string' &&
    typeof o.token === 'string' &&
    typeof o.agentKind === 'string'
  );
}

function isDeployPayload(p: Record<string, unknown>): p is DeployPayload & Record<string, unknown> {
  if (
    typeof p.deployId !== 'string' ||
    typeof p.repoOrPath !== 'string' ||
    typeof p.agentId !== 'string' ||
    typeof p.autoPairToken !== 'string'
  ) {
    return false;
  }
  // cloneToken is optional, but must be a string when present.
  if (p.cloneToken !== undefined && typeof p.cloneToken !== 'string') {
    return false;
  }
  // headroom fields are optional (back-compat: older backends omit them).
  // When present they must have the right types; absence is treated as disabled.
  if (p.headroomEnabled !== undefined && typeof p.headroomEnabled !== 'boolean') {
    return false;
  }
  if (p.headroomAgent !== undefined && typeof p.headroomAgent !== 'string') {
    return false;
  }
  if (p.headroomSavingsIngestUrl !== undefined && typeof p.headroomSavingsIngestUrl !== 'string') {
    return false;
  }
  // Exactly one credential source must be present + well-formed.
  const hasHouse = isHouseProxy(p.houseProxy);
  const hasSealed = typeof p.sealedAgentAuth === 'string';
  return hasHouse || hasSealed;
}

function isStopPayload(p: Record<string, unknown>): p is StopPayload & Record<string, unknown> {
  return typeof p.sessionId === 'string';
}

/**
 * The control channel is a relay session, but it hosts NO agent — it is
 * a command pipe. Report it as a synthetic "control" agent so the relay's
 * required `AgentMetadata` is satisfied without mislabelling a real agent.
 */
const CONTROL_AGENT_META: AgentMetadata = {
  id: 'claude',
  displayName: 'CodeAgent Host Agent',
  binaryName: 'codeam',
  enabled: true,
  supportedAuthKinds: ['oauth_token'],
  preferredAuthKind: 'oauth_token',
};

/**
 * A spawned `codeam pair-auto` child the supervisor manages. Tracked by
 * `deployId` only — the backend correlates the auto-pair token to a real
 * sessionId server-side, so the supervisor never invents/holds one. A
 * `self_hosted_stop { sessionId }` is matched against the deployId (the
 * backend correlates the two), see `stopChild`.
 */
interface ChildSession {
  deployId: string;
  proc: ChildProcess;
}

/**
 * Subprocess runner injectable for `setupHeadroomForSelfHosted`.
 *
 * `run` returns a Promise that resolves to `{ code, stderr }` on command
 * completion/timeout, never rejects. The `timeoutMs` bound is advisory —
 * the runner kills the child after that many milliseconds if it is still
 * running. Real subprocess output is captured via the default runner; tests
 * substitute a deterministic mock without forking.
 *
 * `which` synchronously checks whether a command is on PATH. The default
 * implementation shells out to `execFileSync('which', [cmd])`; tests inject
 * a lookup function so no real subprocess runs and ESM module boundaries are
 * never crossed.
 */
export interface HeadroomRunner {
  run(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ code: number | null; stderr: string }>;
  /** Returns true when `cmd` is present on PATH, false otherwise. */
  which(cmd: string): boolean;
}

/** PEP 668 "externally-managed-environment" signal string (Debian 12+, Ubuntu 24.04+). */
const PEP668_MARKER = 'externally-managed-environment';

/** Timeout for the OS-level bare-box provision (python3+pip+ca-certificates+curl). */
const PM_INSTALL_TIMEOUT_MS = 180_000;

/** Timeout for each `python3 -m pip install ...` attempt. */
const PIP_INSTALL_TIMEOUT_MS = 120_000;

/**
 * Default subprocess runner backed by Node's `spawn` (for async commands)
 * and `execFileSync` (for synchronous `which` checks).
 * Streams stdout/stderr to the host-agent logger, waits for exit (or
 * timeout), and resolves — never rejects.
 */
const defaultHeadroomRunner: HeadroomRunner = {
  which(cmd: string): boolean {
    try {
      execFileSync('which', [cmd], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
  run(cmd, args, opts = {}): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderrBuf = '';
      let settled = false;
      const done = (code: number | null): void => {
        if (settled) return;
        settled = true;
        resolve({ code, stderr: stderrBuf });
      };

      child.stdout?.on('data', (b: Buffer) => {
        const line = b.toString().replace(/\n+$/, '');
        if (line) log.info('host-agent', `headroom[${cmd}]: ${line}`);
      });
      child.stderr?.on('data', (b: Buffer) => {
        const chunk = b.toString();
        stderrBuf += chunk;
        const line = chunk.replace(/\n+$/, '');
        if (line) log.info('host-agent', `headroom[${cmd}]: ${line}`);
      });

      const timeoutMs = opts.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          log.warn('host-agent', `headroom[${cmd}] timed out after ${timeoutMs / 1000}s — aborting`);
          try { child.kill('SIGTERM'); } catch { /* already dead */ }
          done(null);
        }, timeoutMs);
      }

      child.once('exit', (code) => {
        if (timer !== undefined) clearTimeout(timer);
        done(code);
      });
      child.once('error', (e) => {
        if (timer !== undefined) clearTimeout(timer);
        log.trace('host-agent', `headroom[${cmd}] spawn error: ${e.message}`);
        done(null);
      });
    });
  },
};

/**
 * Known OS package managers, in detection-preference order. apt/apk/dnf/yum
 * cover the bulk of Linux fleets; pacman (Arch) and zypper (openSUSE) are
 * checked last so the common distros short-circuit first.
 */
export type PackageManager = 'apt-get' | 'apk' | 'dnf' | 'yum' | 'pacman' | 'zypper';

const PACKAGE_MANAGERS: readonly PackageManager[] = [
  'apt-get',
  'apk',
  'dnf',
  'yum',
  'pacman',
  'zypper',
];

/**
 * Per-package-manager bare-box provision recipe. A bare box may have *nothing*,
 * so every recipe installs the full minimal toolchain Headroom's pip install
 * needs: a Python interpreter + pip, plus `ca-certificates` (without which the
 * PyPI TLS handshake fails) and `curl`.
 *
 * `update` (apt-get only) runs first and is treated as a soft failure — a stale
 * mirror shouldn't abort the install. `install` is the command + args that must
 * exit 0; `usesSudo` is always true here (every entry escalates when non-root).
 */
interface ProvisionRecipe {
  /** Optional pre-step (e.g. `apt-get update`); non-zero is non-fatal. */
  update?: string[];
  /** The install command + args (without sudo); must exit 0 to succeed. */
  install: string[];
}

const PROVISION_RECIPES: Record<PackageManager, ProvisionRecipe> = {
  'apt-get': {
    update: ['apt-get', 'update'],
    install: ['apt-get', 'install', '-y', 'python3', 'python3-pip', 'python3-venv', 'ca-certificates', 'curl'],
  },
  apk: {
    install: ['apk', 'add', '--no-cache', 'python3', 'py3-pip', 'ca-certificates', 'curl'],
  },
  dnf: {
    install: ['dnf', 'install', '-y', 'python3', 'python3-pip', 'ca-certificates', 'curl'],
  },
  yum: {
    install: ['yum', 'install', '-y', 'python3', 'python3-pip', 'ca-certificates', 'curl'],
  },
  pacman: {
    install: ['pacman', '-Sy', '--noconfirm', 'python', 'python-pip', 'ca-certificates', 'curl'],
  },
  zypper: {
    install: ['zypper', '--non-interactive', 'install', 'python3', 'python3-pip', 'ca-certificates', 'curl'],
  },
};

/**
 * Detect the OS package manager available on this box, preferring faster /
 * more common package managers. Returns the first match from
 * {@link PACKAGE_MANAGERS} (apt-get → apk → dnf → yum → pacman → zypper), or
 * `null` when none are present so the caller can degrade gracefully.
 *
 * Detection delegates `which` to the supplied runner so tests can control
 * visibility without crossing ESM module boundaries.
 */
export function detectPackageManager(
  runner: Pick<HeadroomRunner, 'which'>,
): PackageManager | null {
  for (const pm of PACKAGE_MANAGERS) {
    if (runner.which(pm)) return pm;
  }
  return null;
}

/**
 * Ensure pip is available. Fast path: if `pip` or `pip3` already resolves on
 * PATH, return true immediately — a box that has pip almost certainly already
 * has python3, ca-certificates, and curl too, so we do NOT run any
 * package-manager install (no `apt-get update` on every healthy deploy).
 *
 * Only when pip is ABSENT do we treat the box as bare and run the full
 * provision via the detected package manager — installing python3 + pip
 * alongside `ca-certificates` (PyPI TLS) and `curl`. Best-effort and bounded:
 * a missing package manager or a failed install returns false. Never throws.
 */
async function ensurePip(runner: HeadroomRunner): Promise<boolean> {
  // Fast path: pip or pip3 is already on PATH → skip the bare-box provision.
  if (runner.which('pip') || runner.which('pip3')) {
    return true;
  }

  // pip is absent → assume a bare box and provision the full minimal toolchain.
  const pm = detectPackageManager(runner);
  if (!pm) {
    log.warn(
      'host-agent',
      'pip is absent and no known package manager (apt-get/apk/dnf/yum/pacman/zypper) found — skipping Headroom',
    );
    return false;
  }

  // Prefix each command with sudo only when NOT running as root.
  const isRoot = process.getuid?.() === 0;
  const escalate = (argv: string[]): { cmd: string; args: string[] } =>
    isRoot ? { cmd: argv[0], args: argv.slice(1) } : { cmd: 'sudo', args: argv };

  const recipe = PROVISION_RECIPES[pm];
  log.info(
    'host-agent',
    `pip absent — provisioning bare box (python3+pip+ca-certificates+curl) via ${pm}`,
  );

  try {
    // Optional update step (apt-get): non-zero is a soft failure (stale mirror).
    if (recipe.update) {
      const { cmd, args } = escalate(recipe.update);
      const updateResult = await runner.run(cmd, args, { timeoutMs: PM_INSTALL_TIMEOUT_MS });
      if (updateResult.code !== 0) {
        log.warn(
          'host-agent',
          `${pm} update exited ${String(updateResult.code)} — attempting install anyway`,
        );
      }
    }

    const { cmd, args } = escalate(recipe.install);
    const installResult = await runner.run(cmd, args, { timeoutMs: PM_INSTALL_TIMEOUT_MS });
    if (installResult.code !== 0) {
      log.warn(
        'host-agent',
        `${pm} bare-box provision failed (code=${String(installResult.code)}) — skipping Headroom`,
      );
      return false;
    }
  } catch (e) {
    // Unexpected error (should never happen with the runner contract, but guard anyway).
    log.warn(
      'host-agent',
      `bare-box provision threw unexpectedly: ${e instanceof Error ? e.message : String(e)} — skipping Headroom`,
    );
    return false;
  }

  log.info('host-agent', `bare box provisioned via ${pm} (python3+pip+ca-certificates+curl)`);
  return true;
}

/**
 * Map an incoming agent id (a `LinkedAgentId` like `claude_code`, `codex_cli`,
 * or an already-normalized `claude`) to the subcommand kind that `headroom init`
 * understands: `claude` | `codex` | `copilot`.
 *
 * `headroom init` only accepts those exact subcommands — passing the raw
 * LinkedAgentId (`claude_code`) makes it fail with "No such command", and an
 * empty id makes it print a usage error. This collapses the two id spaces.
 *
 * Match is case-insensitive and tolerant of `_`/`-` separators. Anything we
 * don't recognise (including empty/undefined) defaults to `claude` — the most
 * common path, and a safe default since a bad subcommand is worse than a guess.
 */
export function agentIdToHeadroomKind(agentId: string): string {
  const normalized = (agentId ?? '').toLowerCase().replace(/[_-]/g, '');
  if (normalized.startsWith('claude')) return 'claude';
  if (normalized.startsWith('codex')) return 'codex';
  if (normalized.startsWith('copilot')) return 'copilot';
  return 'claude';
}

/**
 * Set up Headroom on the self-hosted box so the pair-auto child's agent
 * routes through the local compression proxy and savings reach the dashboard.
 *
 * Steps (all best-effort — never throws, never blocks the deploy):
 *   0. Ensure pip is available. If neither `pip` nor `pip3` is on PATH, treat
 *      the box as bare and provision python3 + pip + ca-certificates + curl via
 *      the OS package manager (apt-get/apk/dnf/yum/pacman/zypper). Bounded at
 *      180s. Best-effort: if provisioning fails, returns false.
 *   1. `python3 -m pip install --quiet` headroom-ai + companion packages.
 *      On PEP 668 "externally-managed-environment" error (Ubuntu 24.04+,
 *      Debian 12+), retries with `--break-system-packages`. 120s timeout.
 *   2. `headroom init --global <agent>` to write ~/.claude/settings.json.
 *   3. Warm-start `headroom proxy --port 8787` as a detached background process.
 *
 * Returns true when setup succeeded well enough to pass HEADROOM_* env to the
 * child (install + init both ok). Returns false on any failure — the caller
 * must NOT set HEADROOM_* env in that case so the child reporter no-ops.
 *
 * @param agent - e.g. 'claude', passed to `headroom init --global`.
 * @param runner - Injectable subprocess runner. Defaults to `defaultHeadroomRunner`.
 *                 Tests pass a mock so no real apt/pip runs.
 */
export async function setupHeadroomForSelfHosted(
  agent: string,
  runner: HeadroomRunner = defaultHeadroomRunner,
): Promise<boolean> {
  const PIP_PACKAGES = [
    'headroom-ai',
    'fastapi',
    'uvicorn',
    'httpx[http2]',
    'websockets',
    'zstandard',
  ];

  // ── Step 0: Ensure pip is available ──────────────────────────────────────
  const pipAvailable = await ensurePip(runner);
  if (!pipAvailable) {
    return false;
  }

  // ── Step 1: pip install via `python3 -m pip` (best-effort, bounded) ───────
  // Prefer `python3 -m pip` over a bare `pip`/`pip3` binary — it always
  // resolves against the correct interpreter and avoids shebang ambiguities
  // on multi-python boxes. PEP 668 retry: if the first attempt fails with the
  // "externally-managed-environment" error, retry with --break-system-packages.
  const installOk = await (async (): Promise<boolean> => {
    const baseArgs = ['-m', 'pip', 'install', '--quiet', ...PIP_PACKAGES];

    const firstResult = await runner.run('python3', baseArgs, {
      timeoutMs: PIP_INSTALL_TIMEOUT_MS,
    });

    if (firstResult.code === 0) {
      log.info('host-agent', 'headroom pip install succeeded');
      return true;
    }

    // Check for PEP 668 managed-env rejection and retry with the override flag.
    if (firstResult.stderr.includes(PEP668_MARKER)) {
      log.info(
        'host-agent',
        'PEP 668 externally-managed-environment detected — retrying with --break-system-packages',
      );
      const retryResult = await runner.run(
        'python3',
        [...baseArgs, '--break-system-packages'],
        { timeoutMs: PIP_INSTALL_TIMEOUT_MS },
      );
      if (retryResult.code === 0) {
        log.info('host-agent', 'headroom pip install succeeded (--break-system-packages)');
        return true;
      }
      log.warn(
        'host-agent',
        `headroom pip install failed even with --break-system-packages (code=${String(retryResult.code)}) — skipping Headroom`,
      );
      return false;
    }

    log.warn(
      'host-agent',
      `headroom pip install exited code=${String(firstResult.code)} — skipping Headroom`,
    );
    return false;
  })();

  if (!installOk) {
    return false;
  }

  // ── Step 2: `headroom init --global <agent>` (only when headroom is on PATH) ──
  // Verify headroom is on PATH before calling init; on some boxes pip installs
  // to a user-local directory that isn't on the current PATH yet.
  if (!runner.which('headroom')) {
    log.warn('host-agent', 'headroom not found on PATH after install — skipping init');
    return false;
  }
  // Map the incoming agent id (e.g. the LinkedAgentId `claude_code`) to the
  // subcommand kind `headroom init` accepts (`claude`/`codex`/`copilot`).
  // `headroom init` can print "claude not found in PATH" on a self-hosted box
  // (claude is the SDK-bundled binary, not on PATH) but still writes
  // ~/.claude/settings.json and exits 0 — execFile only reports an error on a
  // non-zero exit, so a zero exit is treated as success even with that stderr.
  const initKind = agentIdToHeadroomKind(agent);
  const initOk = await new Promise<boolean>((resolve) => {
    execFile('headroom', ['init', '--global', initKind], (initErr, stdout, stderr) => {
      if (initErr) {
        const detail = (stderr || initErr.message).replace(/\n+$/g, '');
        log.warn('host-agent', `headroom init failed (best-effort): ${detail}`);
        resolve(false);
      } else {
        if (stdout.trim()) log.info('host-agent', `headroom init: ${stdout.trim()}`);
        log.info('host-agent', 'headroom init --global succeeded');
        resolve(true);
      }
    });
  });

  if (!initOk) {
    return false;
  }

  // ── Step 3: warm-start the proxy (detached, best-effort, don't await) ───
  try {
    const proxy = spawn('headroom', ['proxy', '--port', '8787'], {
      stdio: 'ignore',
      detached: true,
    });
    proxy.unref(); // don't keep the supervisor process alive for the proxy
  } catch (e) {
    // Non-fatal — the SessionStart hook in settings.json also ensures the proxy.
    log.warn('host-agent', `headroom proxy warm-start failed (best-effort): ${e instanceof Error ? e.message : String(e)}`);
  }

  return true;
}

/** How the supervisor spawns a child — injectable so tests don't fork. */
export type ChildSpawner = (
  env: Record<string, string>,
  cwd: string,
  args?: string[],
) => ChildProcess;

/**
 * Default spawner: `codeam pair-auto` carrying CODEAM_AUTO_TOKEN. stdout/
 * stderr are PIPED (not ignored) so the supervisor can capture the tail and
 * surface it as a `failed` deploy-progress if the child dies early.
 */
const defaultSpawner: ChildSpawner = (env, cwd, args = []) =>
  spawn(process.execPath, [process.argv[1], 'pair-auto', ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

/**
 * Default self-heal action when the backend rejects the host identity:
 * wipe the sealed identity and exit non-zero so systemd restarts us. On
 * restart, `resolveHostIdentity` redeems a fresh env token if one is
 * present (re-enroll), or fails cleanly if not.
 */
const defaultOnIdentityRejected = (): void => {
  deleteHostIdentity();
  log.warn('host-agent', 'host identity rejected by backend — wiped sealed identity, exiting');
  process.exit(1);
};

/**
 * Default best-effort service de-provision for `self_hosted_wipe`. The
 * agent runs as root via its systemd unit, so it can usually disable
 * itself; wrapped so a permission failure is non-fatal.
 */
const defaultDisableService = (): void => {
  try {
    execFileSync('systemctl', ['disable', '--now', 'codeam-host-agent'], { stdio: 'ignore' });
  } catch {
    /* may not be permitted / not on systemd — best-effort */
  }
};

/** The slice of MetricsCollector the supervisor depends on (injectable for tests). */
export type HostMetricsCollector = Pick<MetricsCollector, 'collect' | 'recordLatency'>;

/** Dependencies the supervisor needs — all injectable for tests. */
export interface HostAgentDeps {
  spawnChild?: ChildSpawner;
  resolveAgentAuth?: AgentAuthResolver;
  /** Live-metrics collector; defaults to a real one. Injectable for tests. */
  metricsCollector?: HostMetricsCollector;
  /** Factory for the relay (lets tests assert subscription without HTTP). */
  makeRelay?: (
    pluginId: string,
    onCommand: (cmd: RemoteCommand) => void | Promise<void>,
    meta: AgentMetadata,
  ) => Pick<CommandRelayService, 'start' | 'stop'>;
  /**
   * Called when the host identity is rejected by the backend (host deleted
   * / token revoked) or on `self_hosted_wipe`. The default wipes the sealed
   * identity and exits non-zero so systemd restarts us; restart then
   * redeems a fresh env token if present, else fails cleanly. Injectable so
   * tests assert the wipe without tearing down the test runner.
   */
  onIdentityRejected?: () => void;
  /** Best-effort de-provision for `self_hosted_wipe`. Injectable for tests. */
  disableService?: () => void;
  /**
   * Headroom setup function. Defaults to `setupHeadroomForSelfHosted`.
   * Injectable so tests mock away real pip/spawn without touching the file system.
   */
  setupHeadroom?: (agent: string) => Promise<boolean>;
}

/**
 * The supervisor. Holds the control channel + the live children. Exposed
 * as a class so tests can drive `handleCommand` directly and assert child
 * tracking without standing up the real relay.
 */
export class HostAgentSupervisor {
  private readonly children = new Map<string, ChildSession>();
  private readonly spawnChild: ChildSpawner;
  private readonly resolveAgentAuth: AgentAuthResolver;
  private readonly setupHeadroom: (agent: string) => Promise<boolean>;
  private relay: Pick<CommandRelayService, 'start' | 'stop'> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Guards the one-shot 'connected' telemetry on the first heartbeat. */
  private reportedConnected = false;
  /** Live-metrics collector — stateful across beats (CPU delta + latency). */
  private readonly metrics: HostMetricsCollector;
  /** Self-heal action when the backend rejects this identity. */
  private readonly onIdentityRejected: () => void;
  /** Best-effort systemd de-provision used by `self_hosted_wipe`. */
  private readonly disableService: () => void;
  /** Guards against firing the self-heal more than once. */
  private healing = false;

  constructor(
    private readonly identity: SealedHostIdentity,
    private readonly deps: HostAgentDeps = {},
  ) {
    this.spawnChild = deps.spawnChild ?? defaultSpawner;
    this.resolveAgentAuth = deps.resolveAgentAuth ?? unsealAgentAuth;
    this.setupHeadroom = deps.setupHeadroom ?? setupHeadroomForSelfHosted;
    this.metrics = deps.metricsCollector ?? new MetricsCollector();
    this.onIdentityRejected = deps.onIdentityRejected ?? defaultOnIdentityRejected;
    this.disableService = deps.disableService ?? defaultDisableService;
  }

  /** Open the control channel (reusing the relay) + start heartbeats. */
  start(): void {
    const make =
      this.deps.makeRelay ??
      ((pluginId, onCommand, meta) => new CommandRelayService(pluginId, onCommand, meta));
    // Reuse the existing SSE-pull relay as the control channel — exactly
    // like a normal session, but subscribed on the host's controlPluginId.
    this.relay = make(
      this.identity.controlPluginId,
      (cmd) => this.handleCommand(cmd),
      CONTROL_AGENT_META,
    );
    this.relay.start();

    // Liveness heartbeat (state, not command polling — the relay is the
    // command channel). Fire one immediately, then on the interval.
    void this.beat();
    this.heartbeatTimer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    log.info('host-agent', `supervisor up host=${this.identity.hostId.slice(0, 8)}`);
  }

  /** Stop the control channel + heartbeats + kill every child. */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.relay?.stop();
    for (const child of this.children.values()) {
      try {
        child.proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    this.children.clear();
  }

  private async beat(): Promise<void> {
    try {
      // Best-effort live metrics. If collection throws, send the heartbeat
      // WITHOUT metrics rather than failing the beat (back-compat: the
      // backend treats `metrics` as optional).
      let metrics: HostMetrics | undefined;
      try {
        metrics = this.metrics.collect();
      } catch (err) {
        log.trace('host-agent', 'metrics collection failed', err);
      }
      // Measure this beat's round-trip and feed it back as the next beat's
      // latencyMs (a real measured value, not a guess).
      const latencyMs = await sendHostHeartbeat(this.identity, metrics);
      this.metrics.recordLatency(latencyMs);
      // First successful heartbeat means the control channel is live —
      // report 'connected' once (host-token auth). Best-effort, fire it
      // off without awaiting so it can't delay the heartbeat cadence.
      if (!this.reportedConnected) {
        this.reportedConnected = true;
        void reportProgress(
          { hostId: this.identity.hostId, hostToken: this.identity.hostToken },
          'connected',
          'host-agent connected',
        );
      }
    } catch (err) {
      // Self-heal: if the backend genuinely REJECTED our host identity
      // (401/403/404 — the host was deleted server-side), don't spin
      // forever on a dead token. Wipe the sealed identity and exit so
      // systemd restarts us; on restart we redeem a fresh env token if one
      // is present, else fail cleanly. Transient failures (5xx, network
      // blips) are NOT rejections — keep retrying on the next beat.
      if (isHostAuthRejection(err)) {
        if (!this.healing) {
          this.healing = true;
          log.warn('host-agent', 'heartbeat rejected — host deleted/revoked, self-healing', err);
          this.onIdentityRejected();
        }
        return;
      }
      log.trace('host-agent', 'heartbeat failed', err);
    }
  }

  /** Number of live children — for tests + diagnostics. */
  childCount(): number {
    return this.children.size;
  }

  /**
   * Route a relay command. Only `self_hosted_deploy` / `self_hosted_stop`
   * are understood; anything else is ignored (the box accepts no
   * arbitrary command surface).
   */
  async handleCommand(cmd: RemoteCommand): Promise<void> {
    if (cmd.type === 'self_hosted_deploy') {
      if (!isDeployPayload(cmd.payload)) {
        log.warn('host-agent', `ignoring malformed self_hosted_deploy id=${cmd.id}`);
        return;
      }
      await this.deploy(cmd.payload);
      return;
    }
    if (cmd.type === 'self_hosted_stop') {
      if (!isStopPayload(cmd.payload)) {
        log.warn('host-agent', `ignoring malformed self_hosted_stop id=${cmd.id}`);
        return;
      }
      this.stopChild(cmd.payload.sessionId);
      return;
    }
    if (cmd.type === 'self_hosted_wipe') {
      // The app deleted this host while it was ONLINE. Cleanly de-provision:
      // kill children, remove the sealed identity, best-effort disable the
      // systemd unit, then exit. (Disabling first means systemd won't simply
      // restart us into a cleanly-failing redeem.)
      log.warn('host-agent', `self_hosted_wipe received id=${cmd.id} — de-provisioning`);
      this.stop();
      this.disableService();
      if (!this.healing) {
        this.healing = true;
        this.onIdentityRejected();
      }
      return;
    }
    log.trace('host-agent', `ignoring unsupported command type=${cmd.type}`);
  }

  /**
   * Prepare the workspace, write the agent credential (same as codespace
   * provisioning), and spawn a supervised `codeam pair-auto` child.
   *
   * The child claims its session via `CODEAM_AUTO_TOKEN`; the backend's
   * claim response is what binds the sessionId on the server side. We key
   * the child by `deployId` immediately (and adopt the sessionId — which
   * for self-hosted equals the deployId-correlated session) so a
   * subsequent `self_hosted_stop` can find it.
   */
  private async deploy(payload: DeployPayload): Promise<void> {
    log.info(
      'host-agent',
      `deploy id=${payload.deployId.slice(0, 8)} agent=${payload.agentId} target=${payload.repoOrPath}`,
    );
    // Best-effort deploy-progress, bound to this deploy + the sealed
    // identity (host-token auth). Fire-and-forget — never await on the hot
    // path; the helper swallows its own errors.
    const report = (step: string, message: string): void => {
      void reportDeployProgress(
        { hostId: this.identity.hostId, hostToken: this.identity.hostToken },
        payload.deployId,
        step,
        message,
      );
    };

    try {
      // 1) Prepare the workspace (clone, or use an absolute path verbatim).
      //    Clones run non-interactively + with the supplied cloneToken so a
      //    private repo authenticates and a bad/missing credential fails
      //    fast instead of hanging the deploy.
      report('preparing', 'preparing workspace');
      if (!isAbsolutePathTarget(payload.repoOrPath)) {
        report('cloning', 'cloning repository');
      }
      const cwd = await prepareWorkspace(payload.repoOrPath, payload.deployId, payload.cloneToken);

      // Two mutually-exclusive credential shapes (see DeployPayload):
      //   - House agent ("CodeAgent Cloud"): point the underlying agent at
      //     our managed proxy with the supplied token — NO unseal round-trip,
      //     NO cred files. Mirrors the codespace house bootstrap env exactly
      //     (apps/api-v2/src/codespaces/agent.ts).
      //   - Real LinkedAgent: unseal the sealed blob → plaintext (outbound,
      //     host-token authed) and write the credential files the agent reads
      //     at startup, BEFORE spawning the child (unchanged path).
      let childEnv: Record<string, string>;
      let extraArgs: string[] = [];
      if (payload.houseProxy) {
        const { baseUrl, token, agentKind } = payload.houseProxy;
        childEnv = {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_AUTH_TOKEN: token,
          ANTHROPIC_MODEL: 'MiniMax-M3',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '512000',
          API_TIMEOUT_MS: '3000000',
          CODEAM_AUTO_TOKEN: payload.autoPairToken,
        };
        extraArgs = [`--agent=${agentKind || 'claude'}`];
      } else {
        // Non-house path: `sealedAgentAuth` is guaranteed present by
        // isDeployPayload (exactly one of houseProxy / sealedAgentAuth).
        const auth = await this.resolveAgentAuth(this.identity, payload.sealedAgentAuth!);
        const credEnv = provisionAgentCredentials(payload.agentId, auth, undefined);
        childEnv = {
          ...credEnv,
          CODEAM_AUTO_TOKEN: payload.autoPairToken,
        };
      }

      // 1b) Install the selected agent's CLI (per-agent strategy from the
      //     backend — same one the codespace bootstrap runs). Best-effort:
      //     a failure never blocks the deploy (the chat agent runs via the
      //     bundled ACP SDK regardless), but without it `claude -p` / `codex`
      //     preview detection finds no binary on a self-hosted box.
      if (payload.agentInstallScript) {
        report('installing', 'installing agent CLI');
        await this.runAgentInstall(payload.agentInstallScript);
      }
      // Put the installer's target (claude.ai/install.sh → ~/.local/bin) on
      // the child's PATH so the freshly-installed binary resolves for both
      // the agent and the `claude -p` / `codex` detection spawn. npm-global
      // installs (codex) already land on PATH; this is the additive case.
      const home = process.env.HOME || os.homedir();
      childEnv.PATH = `${home}/.local/bin:${process.env.PATH ?? ''}`;

      // 1c) Named preview tunnel — same unified env contract the codespace
      //     bootstrap uses. The preview start handler reads these and runs
      //     `cloudflared tunnel run` against our own zone instead of the
      //     intermittently-resolved trycloudflare.com. Absent → quick tunnel.
      if (payload.previewTunnelToken && payload.previewHostname) {
        childEnv.PREVIEW_TUNNEL_TOKEN = payload.previewTunnelToken;
        childEnv.PREVIEW_TUNNEL_HOSTNAME = payload.previewHostname;
      }

      // 1d) Headroom local compression proxy — mirrors the codespace wiring.
      //     Best-effort: a failed/absent headroom install must never block the
      //     deploy. Only inject HEADROOM_* env when setup fully succeeded so the
      //     child's maybeStartHeadroomReporter activates correctly and no broken
      //     ANTHROPIC_BASE_URL reaches the agent.
      if (payload.headroomEnabled && payload.headroomAgent && payload.headroomSavingsIngestUrl) {
        report('headroom', 'setting up Headroom proxy');
        const headroomOk = await this.setupHeadroom(payload.headroomAgent);
        if (headroomOk) {
          childEnv.HEADROOM_ENABLED = '1';
          // Use the mapped headroom kind (e.g. `claude_code` → `claude`) so the
          // env value matches what `headroom init` registered and what the
          // reporter reports as `dto.agentId` — consistent with codespaces,
          // which already reports `claude`.
          childEnv.HEADROOM_AGENT = agentIdToHeadroomKind(payload.headroomAgent);
          childEnv.HEADROOM_SAVINGS_INGEST_URL = payload.headroomSavingsIngestUrl;
          log.info('host-agent', 'Headroom proxy ready; HEADROOM_* env injected into child');
        } else {
          log.warn('host-agent', 'Headroom setup failed (best-effort) — child will run without Headroom');
        }
      }

      // 2) Spawn the supervised `pair-auto` child.
      report('spawning', 'starting agent');
      const proc = this.spawnChild(childEnv, cwd, extraArgs);
      // Track by deployId now; the stop command uses sessionId, which the
      // backend correlates to this deploy (the control channel pushed the
      // stop with the session the child paired into).
      const child: ChildSession = { deployId: payload.deployId, proc };
      this.children.set(payload.deployId, child);

      // Capture a rolling tail of the child's stdout/stderr so an EARLY
      // non-zero exit (the agent failed to start) can be reported with
      // context. Bounded so a long-lived child can't grow this unbounded.
      let tail = '';
      const appendTail = (buf: Buffer): void => {
        tail = (tail + buf.toString('utf8')).slice(-2_000);
      };
      proc.stdout?.on('data', appendTail);
      proc.stderr?.on('data', appendTail);

      report('agent_starting', 'agent process started');

      proc.once('exit', (code) => {
        const tracked = this.children.get(payload.deployId)?.proc === proc;
        // Self-heal the map when a child dies on its own.
        if (tracked) {
          this.children.delete(payload.deployId);
        }
        // A non-zero exit means the agent failed to come up. Report it as a
        // deploy failure with the captured tail (best-effort). A clean exit
        // (code 0 / null from a SIGTERM stop) is normal teardown — no report.
        if (tracked && typeof code === 'number' && code !== 0) {
          const detail = tail.trim().slice(-500);
          report('failed', detail ? `agent exited (${code}): ${detail}` : `agent exited (${code})`);
        }
      });
    } catch (err) {
      // Any failure before/while spawning (clone hang→fast-fail, unseal
      // error, provisioning error) lands here. Report a concise `failed`
      // (NOT a stack), clean up any partial child, and DO NOT rethrow — a
      // throw out of the relay dispatch would be invisible to the app.
      const message = err instanceof Error ? err.message : String(err);
      log.warn('host-agent', `deploy ${payload.deployId.slice(0, 8)} failed: ${message}`);
      const existing = this.children.get(payload.deployId);
      if (existing) {
        try {
          existing.proc.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        this.children.delete(payload.deployId);
      }
      report('failed', message);
    }
  }

  /**
   * Run the backend-supplied per-agent CLI install script (e.g.
   * `claude.ai/install.sh`, `npm i -g @openai/codex`). Best-effort + bounded:
   * a non-zero exit / timeout is logged but never rejects, so a box that
   * can't reach an installer still deploys (the chat agent runs via the
   * bundled ACP SDK; only `claude -p` / `codex` preview detection degrades).
   * HOME is forced so the installer's `~/.local/bin` resolves on a detached
   * host-agent whose env may lack it.
   */
  private runAgentInstall(script: string): Promise<void> {
    return new Promise((resolve) => {
      const home = process.env.HOME || os.homedir();
      const child = spawn('sh', ['-c', script], {
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const onData = (b: Buffer): void => {
        const line = b.toString().replace(/\n+$/g, '');
        if (line) log.info('host-agent', `agent-install: ${line}`);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(() => {
        log.warn('host-agent', 'agent install timed out (180s) — preview detection may be unavailable');
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        done();
      }, 180_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          log.warn('host-agent', `agent install exited code=${code} — preview detection may be unavailable; agent still runs`);
        } else {
          log.info('host-agent', 'agent CLI installed');
        }
        done();
      });
      child.once('error', (e) => {
        clearTimeout(timer);
        log.warn('host-agent', `agent install spawn error: ${e.message}`);
        done();
      });
    });
  }

  /**
   * Kill the child for the given id. The backend correlates the session it
   * sends to this deploy, so the id matches the deployId we keyed on. No-op
   * if absent.
   */
  private stopChild(sessionId: string): void {
    const child = this.children.get(sessionId);
    if (!child) {
      log.trace('host-agent', `stop: no child for sessionId=${sessionId}`);
      return;
    }
    log.info('host-agent', `stopping child deploy=${child.deployId.slice(0, 8)}`);
    try {
      child.proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    this.children.delete(child.deployId);
  }
}

/**
 * Resolve the sealed host identity — REDEEM-FIRST.
 *
 * When the systemd unit carries a `CODEAM_ENROLL_TOKEN`, we PREFER
 * redeeming it over reusing the sealed identity on disk. This is what makes
 * re-enrollment work: a freshly-installed token (the user re-ran the
 * installer, possibly after deleting the old host in the app) must replace
 * any stale, now-dead identity instead of being ignored.
 *
 * The enroll token is single-use server-side, which makes the fallback
 * correct and safe:
 *   - Fresh enroll (a new, unredeemed token) → redeem succeeds → new
 *     identity sealed and returned. Re-enrollment works, and a deleted host
 *     self-replaces.
 *   - Plain service restart / reboot (the SAME token is still in the unit
 *     but was already consumed) → redeem fails → we fall back to the sealed
 *     identity and carry on. No spurious failure on every reboot.
 *
 * Returns null only when there is neither a usable token nor a sealed
 * identity to fall back to.
 */
export async function resolveHostIdentity(
  enrollToken: string | undefined,
): Promise<SealedHostIdentity | null> {
  const existing = loadHostIdentity();

  if (enrollToken) {
    // Box-side telemetry: report the redeem milestone before it lands
    // (enroll-token auth — host identity may be stale or absent). Best-effort.
    await reportProgress({ enrollToken }, 'redeeming', 'redeeming enrollment token…');
    try {
      const identity = await redeemEnrollToken(enrollToken);
      saveHostIdentity(identity);
      // Identity sealed — report enrolled (host-token auth now available).
      await reportProgress(
        { hostId: identity.hostId, hostToken: identity.hostToken },
        'enrolled',
        'host enrolled',
      );
      return identity;
    } catch (err) {
      // Redeem failed — almost always because the token was already
      // consumed (a plain restart with the same unit env). Fall back to the
      // sealed identity if we have one; otherwise the failure is real.
      if (existing) {
        log.trace(
          'host-agent',
          'enroll-token redeem failed; reusing sealed identity (likely a restart)',
          err,
        );
        return existing;
      }
      throw err;
    }
  }

  // No token in the environment — only the sealed identity can start us.
  if (existing) return existing;
  return null;
}

/**
 * Entry point for `codeam host-agent`. Reads the enroll token from
 * `CODEAM_ENROLL_TOKEN` (set by the systemd unit on first boot) or
 * `--token=…`, resolves the identity, and runs the supervisor.
 */
export async function hostAgent(args: string[] = []): Promise<void> {
  const tokenArg = args.find((a) => a.startsWith('--token='));
  const enrollToken =
    (tokenArg ? tokenArg.slice('--token='.length).trim() : '') ||
    process.env.CODEAM_ENROLL_TOKEN ||
    undefined;

  const identity = await resolveHostIdentity(enrollToken);
  if (!identity) {
    throw new Error(
      'host-agent: no sealed host identity and no enroll token. ' +
        'Re-run the installer from the app (tokens expire after 15 min).',
    );
  }

  const supervisor = new HostAgentSupervisor(identity);
  supervisor.start();

  // The supervisor runs until the process is killed (systemd). Keep the
  // event loop alive on the relay + heartbeat timer; tear down on signals.
  const shutdown = (): void => {
    supervisor.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise<void>(() => {
    /* run forever — resolved only by process exit */
  });
}

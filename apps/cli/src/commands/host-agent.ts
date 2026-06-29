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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CommandRelayService, type RemoteCommand } from '../services/command-relay.service';
import type { AgentMetadata } from '@codeagent/shared';
import { resolveApiBaseUrl, getPricing } from '@codeagent/shared';

/** Input $/M for the running agent's representative model — values the
 *  compressed-away tokens for the savings reporter. Claude agents → Sonnet
 *  ($3/M); Codex/GPT → the gpt-5.x row (no public price in our table → 0, so
 *  compression-$ stays 0 rather than mispriced at Claude rates). */
function resolveInputPricePerMillion(agentId: string): number {
  const a = agentId.toLowerCase();
  const model = a.includes('codex') || a.includes('gpt') ? 'gpt-5.5' : 'claude-sonnet-4';
  return getPricing(model).input;
}
import { log } from '../services/logger';
import { restrictToOwner } from '../util/restrict-to-owner';
import {
  deleteHostIdentity,
  isHostAuthRejection,
  isTerminalEnrollError,
  loadHostIdentity,
  MetricsCollector,
  redeemEnrollToken,
  reportDeployProgress,
  reportProgress,
  reportSessionEvent,
  saveHostIdentity,
  sendHostHeartbeat,
  unsealAgentAuth,
  type AgentAuthResolver,
  type HostMetrics,
  type HostSession,
  type SealedHostIdentity,
} from './host/host-client';
import { isAbsolutePathTarget, prepareWorkspace } from './host/workspace';
import { provisionAgentCredentials } from './host/agent-provisioning';
import {
  ensureGhCli,
  ensureGhAuth,
  defaultGitToolingRunner,
  codeamBinDir,
} from './host/git-tooling';
import {
  HeadroomStatsReporter,
  type Savings,
  type StatsShape,
} from '../services/headroom/stats-reporter';
import { buildBudgetProxyArgs } from '../services/headroom/budget-args';
import { compareSemver } from '../lib/updateNotifier';

/** Liveness heartbeat cadence. State liveness only — NOT command polling. */
const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Version string injected at build time by tsup's `define` (from the CLI's
 * own package.json — the same constant `version.ts` / `updateNotifier.ts`
 * read). The running self-hosted box compares THIS against npm's `latest`
 * to decide whether to self-update. Falls back to the literal `unknown`
 * under a non-tsup build (dev tests via tsx), which the compare treats as
 * "never newer" so a dev run can't trigger a self-update.
 */
declare const __CLI_VERSION__: string;

/** The npm package the host-agent ships in — the self-update target. */
const SELF_UPDATE_PKG = 'codeam-cli';

/**
 * Self-update cadence. Self-hosted boxes run `codeam host-agent` as a
 * long-lived systemd service (`Restart=always`), so they never pick up a
 * published fix on their own. On this interval the supervisor does a
 * best-effort `npm view <pkg> version`, and if a newer version is
 * published, `npm install -g <pkg>@latest` then exits so systemd
 * relaunches the new code. Override via `CODEAM_HOST_SELF_UPDATE_MS`; set
 * 0 (or negative) to DISABLE (tests / pinned boxes).
 */
const SELF_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

/** Timeout for the `npm view <pkg> version` registry lookup. */
const SELF_UPDATE_VIEW_TIMEOUT_MS = 30_000;

/** Timeout for the `npm install -g <pkg>@latest` install. */
const SELF_UPDATE_INSTALL_TIMEOUT_MS = 180_000;

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
export function maybeStartHeadroomReporter(ctx: HeadroomReporterCtx): HeadroomStatsReporter | null {
  if (process.env['HEADROOM_ENABLED'] !== '1') return null;

  try {
    const ingestUrl =
      process.env['HEADROOM_SAVINGS_INGEST_URL'] ??
      `${resolveApiBaseUrl()}/api/codespaces/${ctx.codespaceId}/headroom-savings`;

    const reporter = new HeadroomStatsReporter({
      inputPricePerMillionUsd: resolveInputPricePerMillion(
        process.env['HEADROOM_AGENT'] ?? 'claude',
      ),
      fetchStats: async () => {
        const res = await fetch('http://localhost:8787/stats');
        // res.json() returns unknown; cast at this validated boundary.
        return res.json() as Promise<StatsShape>;
      },
      postSavings: async (delta, budget) => {
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
            ...(budget ? {
              periodSpendUsd: budget.periodSpendUsd,
              budgetUsd: budget.budgetUsd,
              budgetPeriod: budget.budgetPeriod,
            } : {}),
          }),
        });
      },
    });
    reporter.start();
    return reporter;
  } catch (err) {
    log.warn(
      'headroom',
      `failed to start Headroom reporter (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Resume the ON-DEMAND LOCAL Headroom savings reporter at boot from the
 * persisted `~/.codeam/headroom-config.json`.
 *
 * The codespace / self-hosted path uses {@link maybeStartHeadroomReporter},
 * gated on `HEADROOM_ENABLED === '1'` (env injected by the backend bootstrap).
 * A local on-demand session NEVER sets that env — only the JSON config records
 * `enabled:true` — so without this resume a CLI restart would silently stop
 * reporting savings until the user re-toggled Cost-saving from the app.
 *
 * Strictly additive to the codespace path: this returns `null` immediately when
 * `HEADROOM_ENABLED === '1'`, so the two paths can never both run and the
 * codespace reporter is completely untouched. Posts to the CURRENT session's
 * ingest endpoint (built from `ctx.sessionId`), NOT the URL baked into the
 * config at enable time — so a fresh session after restart credits the right
 * session. Best-effort; never throws into the launch path.
 */
export function maybeResumeLocalHeadroomReporter(ctx: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
}): HeadroomStatsReporter | null {
  // Never overlap the codespace/self-hosted env-gated path.
  if (process.env['HEADROOM_ENABLED'] === '1') return null;
  try {
    const file = headroomConfigPath();
    if (!fs.existsSync(file)) return null;
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as HeadroomConfig;
    if (!cfg?.enabled) return null;

    const agent = cfg.agent ?? 'claude';
    // Build from the CURRENT session — the config's stored ingestUrl bakes the
    // session id from enable time and is stale for any later session.
    const ingestUrl = `${resolveApiBaseUrl()}/api/sessions/${ctx.sessionId}/headroom-savings`;

    const reporter = new HeadroomStatsReporter({
      inputPricePerMillionUsd: resolveInputPricePerMillion(agent),
      fetchStats: async () => {
        const res = await fetch('http://localhost:8787/stats');
        return res.json() as Promise<StatsShape>;
      },
      // Body MUST match HeadroomSavingsDto + PluginAuthGuard (sessionId +
      // pluginId in the body) — same shape as the codespace reporter above and
      // the on-demand `startReporter` in handlers.ts.
      postSavings: async (delta, budget) => {
        await fetch(ingestUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Plugin-Auth-Token': ctx.pluginAuthToken,
          },
          body: JSON.stringify({
            sessionId: ctx.sessionId,
            pluginId: ctx.pluginId,
            agentId: agent,
            savings: delta,
            ...(budget ? {
              periodSpendUsd: budget.periodSpendUsd,
              budgetUsd: budget.budgetUsd,
              budgetPeriod: budget.budgetPeriod,
            } : {}),
          }),
        });
      },
    });
    reporter.start();
    log.info('headroom', 'resumed on-demand local savings reporter from config');
    return reporter;
  } catch (err) {
    log.warn(
      'headroom',
      `failed to resume local Headroom reporter (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
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

/** Payload of `self_hosted_refresh_credentials` (re-link credential sweep). */
interface RefreshCredentialsPayload {
  agentId: string;
  sealedAgentAuth: string;
}

function isRefreshCredentialsPayload(
  p: Record<string, unknown>,
): p is RefreshCredentialsPayload & Record<string, unknown> {
  return typeof p.agentId === 'string' && typeof p.sealedAgentAuth === 'string';
}

function isHouseProxy(v: unknown): v is HouseProxy {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.baseUrl === 'string' && typeof o.token === 'string' && typeof o.agentKind === 'string'
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
  /**
   * The agent kind this child runs (the deploy's `agentId`), surfaced on the
   * heartbeat so the app's My Servers screen can label the active session.
   */
  agent: string;
  /** epoch ms when the child was spawned — surfaced on the heartbeat. */
  startedAt: number;
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
    opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ code: number | null; stderr: string; stdout?: string }>;
  /** Returns true when `cmd` is present on PATH, false otherwise. */
  which(cmd: string): boolean;
}

/** PEP 668 "externally-managed-environment" signal string (Debian 12+, Ubuntu 24.04+). */
const PEP668_MARKER = 'externally-managed-environment';

/** Timeout for the OS-level bare-box provision (python3+pip+ca-certificates+curl). */
const PM_INSTALL_TIMEOUT_MS = 180_000;

/** Timeout for each `python3 -m pip install ...` attempt. */
const PIP_INSTALL_TIMEOUT_MS = 120_000;

/** Timeout for the heavier Headroom-engine installs (PyTorch + the ML/AST
 *  extras are large — several minutes on a cold box). */
const ENGINE_INSTALL_TIMEOUT_MS = 360_000;

/** Free disk Headroom's ONNX engines need (onnxruntime + transformers +
 *  tree-sitter + the ~840 MB Kompress model + pip temp ≈ 1.5 GB; 2 GB leaves
 *  headroom). Below this we skip the install and tell the user rather than
 *  fill the host's disk. ONNX is far lighter than the old torch path (>3 GB). */
const HEADROOM_MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;

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
  run(cmd, args, opts = {}): Promise<{ code: number | null; stderr: string; stdout?: string }> {
    return new Promise((resolve) => {
      const spawnEnv = opts.env ?? process.env;
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv });
      let stderrBuf = '';
      let stdoutBuf = '';
      let settled = false;
      const done = (code: number | null): void => {
        if (settled) return;
        settled = true;
        // stdout MUST be returned (not just logged) — callers like
        // resolveHeadroomPython parse it (e.g. the `python --version` probe).
        resolve({ code, stderr: stderrBuf, stdout: stdoutBuf });
      };

      child.stdout?.on('data', (b: Buffer) => {
        const chunk = b.toString();
        stdoutBuf += chunk;
        const line = chunk.replace(/\n+$/, '');
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
          log.warn(
            'host-agent',
            `headroom[${cmd}] timed out after ${timeoutMs / 1000}s — aborting`,
          );
          try {
            child.kill('SIGTERM');
          } catch {
            /* already dead */
          }
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
    install: [
      'apt-get',
      'install',
      '-y',
      'python3',
      'python3-pip',
      'python3-venv',
      'ca-certificates',
      'curl',
    ],
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
    install: [
      'zypper',
      '--non-interactive',
      'install',
      'python3',
      'python3-pip',
      'ca-certificates',
      'curl',
    ],
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
export function detectPackageManager(runner: Pick<HeadroomRunner, 'which'>): PackageManager | null {
  for (const pm of PACKAGE_MANAGERS) {
    if (runner.which(pm)) return pm;
  }
  return null;
}

/**
 * Prefix a command + args with `sudo` only when NOT running as root. Shared by
 * the bare-box provision (`ensurePip`) and the modern-Python auto-install
 * (`ensureModernPython`) so the sudo policy lives in exactly one place.
 */
function escalateCommand(argv: string[]): { cmd: string; args: string[] } {
  const isRoot = process.getuid?.() === 0;
  return isRoot ? { cmd: argv[0], args: argv.slice(1) } : { cmd: 'sudo', args: argv };
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
  const escalate = escalateCommand;

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
 * Whether Headroom can wrap this agent. The Headroom kind IS the agent
 * Headroom launches, so wrapping an UNSUPPORTED agent would mislaunch it as
 * the `agentIdToHeadroomKind` fallback (Claude). For unsupported agents Headroom
 * must be DISABLED so the agent runs natively.
 *
 * Supported = the agents `headroom wrap <kind>` actually LAUNCHES through the
 * proxy: claude, codex, copilot. NOT cursor — `headroom wrap cursor` is
 * "manual setup" (it only prints base-URLs for the Cursor IDE; the headless
 * cursor-agent CLI has no base-URL override, so Headroom can't route it). NOT
 * gemini. Those run natively (cursor additionally runs over ACP).
 */
export function isHeadroomSupportedAgent(agentId: string): boolean {
  const n = (agentId ?? '').toLowerCase().replace(/[_-]/g, '');
  return n.startsWith('claude') || n.startsWith('codex') || n.startsWith('copilot');
}

/**
 * Persisted Headroom config the supervisor writes on a successful deploy and
 * re-reads on every child spawn (resume / restart / fresh deploy). This is the
 * single source of truth for the child's HEADROOM_* env so reporting survives
 * a session resume or a supervisor restart (systemd / periodic self-update),
 * not just the fresh-deploy path.
 *
 * Path: `~/.codeam/headroom-config.json`. Shape:
 *   { "enabled": true, "agent": "claude", "ingestUrl": "https://…/savings" }
 */
export function headroomConfigPath(): string {
  return path.join(os.homedir(), '.codeam', 'headroom-config.json');
}

/** The on-disk Headroom config shape (mirrors {@link readHeadroomChildEnv}). */
interface HeadroomConfig {
  enabled: boolean;
  /** Mapped headroom kind (`agentIdToHeadroomKind` output, e.g. `claude`). */
  agent?: string;
  /** Full savings ingest URL (POST target). */
  ingestUrl?: string;
  /** Whether a spend budget is active. Persisted so self-hosted restarts re-inject it. */
  budgetEnabled?: boolean;
  /** Budget ceiling in USD (e.g. `10`). Present only when `budgetEnabled` is true. */
  budgetUsd?: number;
  /** Budget reset period — mirrors `headroom proxy --budget-period`. */
  budgetPeriod?: 'hourly' | 'daily' | 'monthly';
}

/**
 * Persist the Headroom config atomically (write a temp file, then rename) so a
 * concurrent reader never sees a half-written file. Best-effort: a failure to
 * persist is logged and swallowed — it must NEVER break the deploy.
 *
 * Pass `enabled: false` (or no agent/ingestUrl) when Headroom did NOT set up
 * successfully so a later resume doesn't wrongly point the agent at a dead
 * proxy via {@link readHeadroomChildEnv}.
 */
export function persistHeadroomConfig(config: HeadroomConfig): void {
  try {
    const file = headroomConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    restrictToOwner(file);
  } catch (err) {
    log.warn(
      'host-agent',
      `failed to persist headroom config (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Progress step identifiers emitted by {@link setupHeadroomForSelfHosted}.
 * In order: pip install → model pre-download → headroom init → proxy spawn → done.
 */
export type HeadroomStep = 'pip' | 'model' | 'init' | 'proxy' | 'ready';

/**
 * Map a headroom kind (`claude`/`codex`/`copilot`) to the agent settings file
 * that `headroom init --global` writes and that we back up before init so the
 * user's prior customisations survive a Headroom upgrade/re-init.
 */
function agentSettingsPath(kind: string): string | null {
  const home = os.homedir();
  if (kind === 'claude') return path.join(home, '.claude', 'settings.json');
  if (kind === 'codex') return path.join(home, '.codex', 'auth.json');
  if (kind === 'copilot') return path.join(home, '.config', 'github-copilot', 'hosts.json');
  return null;
}

/**
 * Copy the agent's settings file to `~/.codeam/headroom-backup-<kind>.json`
 * before `headroom init` so the user's customisations can be restored later.
 * Best-effort: a missing source file or write failure is logged and swallowed.
 */
export function backupAgentHeadroomConfig(kind: string): void {
  const src = agentSettingsPath(kind);
  if (!src) return;
  try {
    if (!fs.existsSync(src)) return;
    const dest = path.join(os.homedir(), '.codeam', `headroom-backup-${kind}.json`);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o600);
    log.info('host-agent', `headroom config backup: ${src} → ${dest}`);
  } catch (err) {
    log.warn(
      'host-agent',
      `headroom config backup failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Restore the agent's settings file from `~/.codeam/headroom-backup-<kind>.json`.
 * Returns `true` when the backup existed and was copied back, `false` when no
 * backup was found (i.e. there was nothing to restore).
 * Best-effort: a write failure is logged and swallowed.
 */
export function restoreAgentHeadroomConfig(kind: string): boolean {
  const dest = agentSettingsPath(kind);
  if (!dest) return false;
  const src = path.join(os.homedir(), '.codeam', `headroom-backup-${kind}.json`);
  if (!fs.existsSync(src)) return false;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o600);
    log.info('host-agent', `headroom config restored: ${src} → ${dest}`);
    return true;
  } catch (err) {
    log.warn(
      'host-agent',
      `headroom config restore failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Read the persisted Headroom config and translate it into the HEADROOM_* env
 * the pair-auto child needs to start its savings reporter. This is invoked at
 * EVERY child spawn (fresh deploy AND resume / restart) so reporting survives
 * session resumes and supervisor restarts, not just the fresh-deploy path.
 *
 * Returns the 3 env vars only when the persisted config is `enabled` AND both
 * `agent` and `ingestUrl` are present non-empty strings. Otherwise (missing
 * file, bad JSON, disabled, or incomplete) returns `{}` so the child's
 * `maybeStartHeadroomReporter` no-ops and no dangling ANTHROPIC_BASE_URL is set.
 *
 * Best-effort: any read/parse error maps to `{}`. Exported for tests.
 */
export function readHeadroomChildEnv(): Record<string, string> {
  try {
    const raw = fs.readFileSync(headroomConfigPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const o = parsed as Record<string, unknown>;
    if (
      o.enabled === true &&
      typeof o.agent === 'string' &&
      o.agent.length > 0 &&
      typeof o.ingestUrl === 'string' &&
      o.ingestUrl.length > 0
    ) {
      const env: Record<string, string> = {
        HEADROOM_ENABLED: '1',
        HEADROOM_AGENT: o.agent,
        HEADROOM_SAVINGS_INGEST_URL: o.ingestUrl,
      };
      // Forward budget constraints so the proxy launch and savings reporter
      // pick them up on every child spawn / supervisor restart.
      // Read from the persisted config (not process.env) so self-hosted
      // supervisor restarts and reboots survive without the parent process env.
      if (
        o.budgetEnabled === true &&
        typeof o.budgetUsd === 'number'
      ) {
        env['HEADROOM_BUDGET'] = String(o.budgetUsd);
        env['HEADROOM_BUDGET_PERIOD'] =
          typeof o.budgetPeriod === 'string' ? o.budgetPeriod : 'daily';
      }
      return env;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Locate the directory holding the SDK-bundled `claude` binary, so it can be
 * prepended to `headroom init`'s PATH.
 *
 * `headroom init --global claude` (≥0.26) HARD-FAILS with "'claude' not found
 * in PATH. Install Claude Code first." when no `claude` is on PATH. On a
 * self-hosted box claude ships ONLY as the platform binary under
 * `@anthropic-ai/claude-agent-sdk-<platform>/claude` (the same binary the ACP
 * adapter spawns by absolute path) — never on PATH. We resolve that dir here
 * and inject it for the init call only; we never mutate the global PATH or
 * symlink, and the runtime hooks headroom writes invoke `headroom`, not
 * `claude`, so the child needs nothing extra. Returns null when not found
 * (init then fails gracefully, exactly as before).
 */
function bundledClaudeBinDir(): string | null {
  // Collect candidate node_modules roots by walking up from this module's dir
  // (the bundled dist lives at <cli-root>/dist, so <cli-root>/node_modules is
  // one hop up). We deliberately do NOT use
  // `require.resolve('@anthropic-ai/claude-agent-sdk/package.json')` — the
  // SDK's strict `exports` map blocks the ./package.json subpath and throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED (the v2.39.58 failure mode).
  const roots = new Set<string>();
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    roots.add(path.join(dir, 'node_modules'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Hoisting-proof fallback: derive the node_modules root from the SDK's MAIN
  // entry (its main IS exported, unlike ./package.json).
  try {
    const main = require.resolve('@anthropic-ai/claude-agent-sdk');
    const marker = `${path.sep}@anthropic-ai${path.sep}`;
    const idx = main.lastIndexOf(marker);
    if (idx !== -1) roots.add(main.slice(0, idx));
  } catch {
    /* ignore — the walk-up roots are the primary path */
  }

  for (const nm of roots) {
    const atAnthropic = path.join(nm, '@anthropic-ai');
    let entries: string[];
    try {
      entries = fs.readdirSync(atAnthropic);
    } catch {
      continue; // root doesn't exist / not readable
    }
    for (const entry of entries) {
      if (!entry.startsWith('claude-agent-sdk-')) continue; // platform package
      const bin = path.join(atAnthropic, entry, 'claude');
      if (fs.existsSync(bin)) return path.dirname(bin);
    }
  }
  return null;
}

/**
 * Free bytes on the filesystem backing `dir`, or null when it can't be
 * determined (statfs unavailable / errored). Callers treat null as "unknown —
 * don't block." Exported for testing. Node ≥ 20 provides `fs.promises.statfs`.
 */
export async function getFreeDiskBytes(dir: string): Promise<number | null> {
  try {
    const s = await fs.promises.statfs(dir);
    return s.bsize * s.bavail;
  } catch {
    return null;
  }
}

/**
 * Probe candidates for a Python interpreter that meets headroom-ai's minimum
 * version requirement (≥3.10, the oldest abi3 wheel tag headroom-ai ships).
 *
 * On macOS the bare `python3` resolves to Xcode's Python 3.9.6 (pip 21.2.4),
 * which has no headroom-ai wheel (`Could not find a version that satisfies the
 * requirement`). The same box may have `/opt/homebrew/bin/python3.13` that
 * installs fine. We therefore probe version-suffixed binaries FIRST (newest
 * first) so the newest available modern interpreter wins, then fall back to
 * bare `python3` ONLY when it is itself ≥3.10.
 *
 * Probe order:
 *   1. Version-suffixed on PATH: python3.13 → python3.12 → python3.11 → python3.10
 *   2. Common absolute locations (macOS Homebrew arm64 + Intel + Linux):
 *      /opt/homebrew/bin/<suffix> and /usr/local/bin/<suffix>, same suffix order.
 *   3. Bare `python3` (accepted only when its reported version is ≥3.10).
 *
 * Returns the first qualifying binary string, or null when none is found.
 * Best-effort: a probe that errors or times out just skips that candidate.
 * Never throws.
 */
export async function resolveHeadroomPython(runner: HeadroomRunner): Promise<string | null> {
  /** Short probe timeout — we're just asking for a version string. */
  const PROBE_TIMEOUT_MS = 5_000;

  /** Suffixed variants to try, newest first (highest minor wins). */
  const SUFFIXES = ['python3.13', 'python3.12', 'python3.11', 'python3.10'] as const;

  /** Absolute prefix directories to check alongside PATH. */
  const PREFIX_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'] as const;

  /**
   * Probe a single candidate binary. Returns true when it is Python ≥3.10
   * AND has a usable `pip` — both are required to install headroom-ai. The pip
   * check matters because the NEWEST python on a box can be a pip-less minimal
   * build (e.g. a distro's `python3.13-minimal` pulled as a transitive apt dep)
   * while an older-but-complete `python3.12` has pip; we must pick the latter.
   */
  const probe = async (candidate: string): Promise<boolean> => {
    try {
      const r = await runner.run(
        candidate,
        ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      if (r.code !== 0) return false;
      const parts = (r.stdout ?? '').trim().split('.');
      const major = parseInt(parts[0] ?? '', 10);
      const minor = parseInt(parts[1] ?? '', 10);
      if (!(major === 3 && minor >= 10)) return false;
      // Require a working pip on THIS interpreter — `<py> -m pip --version`.
      const pipCheck = await runner.run(candidate, ['-m', 'pip', '--version'], {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      return pipCheck.code === 0;
    } catch {
      return false;
    }
  };

  // 1. Version-suffixed on PATH (PATH-resolved; no absolute prefix).
  for (const suffix of SUFFIXES) {
    try {
      if (await probe(suffix)) return suffix;
    } catch {
      /* skip */
    }
  }

  // 2. Absolute locations for each suffix (macOS Homebrew arm64 + Intel + Linux).
  for (const suffix of SUFFIXES) {
    for (const dir of PREFIX_DIRS) {
      const candidate = `${dir}/${suffix}`;
      try {
        if (await probe(candidate)) return candidate;
      } catch {
        /* skip */
      }
    }
  }

  // 3. Bare `python3` — accepted only when it is itself ≥3.10.
  try {
    if (await probe('python3')) return 'python3';
  } catch {
    /* skip */
  }

  return null;
}

/** Generous bound for an OS package-manager / brew Python install (cold mirror
 *  + a fat python3.12 package can take a while). Matches the bare-box budget. */
const PY_INSTALL_TIMEOUT_MS = 600_000;

/**
 * Per-package-manager modern-Python install recipes, in attempt order. The
 * detection itself is reused from {@link detectPackageManager} — we only map a
 * manager to the package name(s) to try here. A version-suffixed package is
 * preferred where the manager ships one (apt's `python3.12`, dnf's `python3.12`)
 * so a box stuck on an old system python3 still gets a ≥3.10 interpreter; we
 * fall back to the unversioned package when no suffixed one exists. Each entry
 * is a list of `install` argv (without sudo); they are tried in order until one
 * exits 0. Best-effort: a failed install is non-fatal (we re-resolve after).
 */
const MODERN_PYTHON_RECIPES: Record<PackageManager, string[][]> = {
  'apt-get': [
    ['apt-get', 'install', '-y', 'python3.12'],
    ['apt-get', 'install', '-y', 'python3.11'],
    ['apt-get', 'install', '-y', 'python3'],
  ],
  dnf: [
    ['dnf', 'install', '-y', 'python3.12'],
    ['dnf', 'install', '-y', 'python3'],
  ],
  yum: [
    ['yum', 'install', '-y', 'python3.12'],
    ['yum', 'install', '-y', 'python3'],
  ],
  apk: [['apk', 'add', '--no-cache', 'python3']],
  pacman: [['pacman', '-Sy', '--noconfirm', 'python']],
  zypper: [
    ['zypper', '--non-interactive', 'install', 'python311'],
    ['zypper', '--non-interactive', 'install', 'python3'],
  ],
};

/**
 * Resolve a Python ≥3.10 interpreter for Headroom, AUTO-INSTALLING a modern
 * Python when none is present rather than skipping. Wraps
 * {@link resolveHeadroomPython}:
 *
 *   1. If a ≥3.10 interpreter already exists, return it immediately (no install).
 *   2. Otherwise attempt a best-effort, bounded install of a modern Python:
 *      • macOS: `brew install python@3.12` when `brew` is on PATH (Homebrew
 *        drops it at /opt/homebrew/bin or /usr/local/bin — both already probed
 *        by resolveHeadroomPython). No brew → no safe auto-install, fall through.
 *      • Linux: reuse {@link detectPackageManager} + {@link escalateCommand}
 *        (the same PM detection + sudo policy as `ensurePip`) and run the
 *        per-manager modern-Python recipe (versioned package preferred).
 *      • Any other platform: no install.
 *   3. Re-run resolveHeadroomPython and return its result (the freshly-installed
 *      interpreter, or null when the install didn't yield a ≥3.10 Python).
 *
 * Best-effort throughout — never throws. Returns the interpreter string or null.
 */
export async function ensureModernPython(runner: HeadroomRunner): Promise<string | null> {
  // 1. Already have a qualifying interpreter — no install needed.
  let py = await resolveHeadroomPython(runner);
  if (py !== null) return py;

  // 2. No ≥3.10 Python found → attempt a best-effort install.
  try {
    if (process.platform === 'darwin') {
      if (runner.which('brew')) {
        log.info('host-agent', 'no Python ≥3.10 found — installing python@3.12 via Homebrew');
        const r = await runner.run('brew', ['install', 'python@3.12'], {
          timeoutMs: PY_INSTALL_TIMEOUT_MS,
        });
        if (r.code !== 0) {
          log.warn(
            'host-agent',
            `brew install python@3.12 exited ${String(r.code)} — will re-probe anyway`,
          );
        }
      } else {
        log.warn(
          'host-agent',
          'no Python ≥3.10 and Homebrew is absent — cannot auto-install Python on macOS',
        );
      }
    } else if (process.platform === 'linux') {
      const pm = detectPackageManager(runner);
      if (!pm) {
        log.warn(
          'host-agent',
          'no Python ≥3.10 and no known package manager (apt-get/apk/dnf/yum/pacman/zypper) — cannot auto-install Python',
        );
      } else {
        log.info('host-agent', `no Python ≥3.10 found — installing a modern Python via ${pm}`);
        for (const argv of MODERN_PYTHON_RECIPES[pm]) {
          const { cmd, args } = escalateCommand(argv);
          const r = await runner.run(cmd, args, { timeoutMs: PY_INSTALL_TIMEOUT_MS });
          if (r.code === 0) {
            log.info('host-agent', `installed Python package via ${pm}: ${argv.join(' ')}`);
            break;
          }
          log.warn(
            'host-agent',
            `${pm} install '${argv.join(' ')}' exited ${String(r.code)} — trying next`,
          );
        }
      }
    } else {
      log.warn(
        'host-agent',
        `no Python ≥3.10 and platform '${process.platform}' has no auto-install path`,
      );
    }
  } catch (e) {
    // The runner contract never rejects, but guard anyway — best-effort.
    log.warn(
      'host-agent',
      `Python auto-install threw unexpectedly (best-effort): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // 3. Re-resolve after the install attempt — newly-installed interpreter or null.
  py = await resolveHeadroomPython(runner);
  return py;
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
 *   0b. Resolve a Python interpreter ≥3.10. headroom-ai ships abi3 wheels tagged
 *      cp310, so Python 3.9 (e.g. macOS Xcode's default) has no matching wheel.
 *      Version-suffixed binaries (python3.13…python3.10) are probed newest-first;
 *      bare `python3` is accepted only when it is itself ≥3.10. If none is found,
 *      skips Headroom and warns (install python3.11+ via brew/apt).
 *   1. `<py> -m pip install --quiet` headroom-ai + companion packages.
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
  opts: { extras?: string[]; onProgress?: (step: HeadroomStep) => void } = {},
): Promise<boolean> {
  const extras = opts.extras ?? ['proxy', 'code'];
  const onProgress = opts.onProgress ?? (() => {});
  // The proxy's HTTP/server deps. The COMPRESSION ENGINES come from the
  // headroom-ai extras below — NOT this list.
  const SERVER_DEPS = ['fastapi', 'uvicorn', 'httpx[http2]', 'websockets', 'zstandard'];

  // ── Step 0: Ensure pip is available ──────────────────────────────────────
  // Disk preflight lives in the deploy caller (it owns the app-feedback
  // channel) — see the headroom step in prepareAndSpawn.
  const pipAvailable = await ensurePip(runner);
  if (!pipAvailable) {
    return false;
  }

  // ── Step 0b: Resolve a Python ≥3.10 interpreter ─────────────────────────
  // headroom-ai ships abi3 wheels tagged cp310. The macOS default `python3` is
  // Xcode's Python 3.9.6 (pip 21.2.4), which has no matching wheel → pip errors
  // "Could not find a version that satisfies the requirement headroom-ai[...]
  // (from versions: none)" → install silently fails → Headroom skipped.
  // The same box typically has /opt/homebrew/bin/python3.13 where it installs
  // fine. We probe version-suffixed binaries newest-first so the best available
  // modern interpreter is used; bare `python3` is a last resort accepted only
  // when it is itself ≥3.10 (modern Linux distros are).
  // ensurePip runs BEFORE this resolver so a freshly-provisioned python3 on a
  // bare Linux box is in scope. When no ≥3.10 interpreter exists,
  // ensureModernPython AUTO-INSTALLS one (brew on macOS, the OS package manager
  // on Linux) and re-probes — we only skip when the install also fails to yield
  // a qualifying interpreter.
  const py = await ensureModernPython(runner);
  if (py === null) {
    log.warn(
      'host-agent',
      'Headroom needs Python ≥3.10 and auto-install failed (no brew on macOS / package manager couldn’t provide it) — skipping Headroom',
    );
    return false;
  }
  log.info('host-agent', `Headroom will use interpreter: ${py}`);

  // pip install with the PEP 668 "externally-managed-environment" retry
  // (Ubuntu 24.04+/Debian 12+). We use the resolved ≥3.10 interpreter explicitly
  // rather than bare `python3`, which can be an old system/Xcode 3.9 that has
  // no headroom-ai wheel. `<py> -m pip` resolves pip against the right interpreter.
  const pipInstall = async (
    pkgs: string[],
    extraArgs: string[],
    timeoutMs: number,
  ): Promise<boolean> => {
    const base = ['-m', 'pip', 'install', '--quiet', ...extraArgs, ...pkgs];
    const r = await runner.run(py, base, { timeoutMs });
    if (r.code === 0) return true;
    if (r.stderr.includes(PEP668_MARKER)) {
      const r2 = await runner.run(py, [...base, '--break-system-packages'], { timeoutMs });
      return r2.code === 0;
    }
    return false;
  };

  // ── Step 1: install Headroom WITH its compression engines (ONNX) ──────────
  // This is the whole point of Headroom and what we previously got wrong: the
  // engines that actually compress a coding agent's code+prose context are
  //   • Kompress — the trained ML compressor that delivers the real savings, and
  //   • CodeCompressor — AST-aware (the `[code]` extra → tree-sitter).
  // Installing bare `headroom-ai` (as we used to) leaves only the JSON
  // compressor, which finds nothing to do on coding traffic → ~0% saved.
  //
  // CRITICAL: Kompress runs on the ONNX Runtime, NOT PyTorch. The `[proxy]`
  // extra pulls onnxruntime + transformers (everything Kompress needs); we do
  // NOT install `[ml]`/torch. torch is multi-GB, disk-fragile, and a broken
  // torch makes the proxy HANG every request when Kompress lazy-loads it
  // (observed live: a torch corrupted by an ENOSPC install threw "torch has no
  // attribute 'library' — circular import", wedging every prompt at
  // "Thinking…"). ONNX is lighter (~1.5 GB total) and robust. All best-effort +
  // bounded: a box too small falls back to launching the agent direct.
  onProgress('pip');
  const headroomPkg = `headroom-ai[${extras.join(',')}]`;
  const installOk = await pipInstall([headroomPkg, ...SERVER_DEPS], [], ENGINE_INSTALL_TIMEOUT_MS);
  if (!installOk) {
    log.warn('host-agent', `headroom engine install failed (${headroomPkg}) — skipping Headroom`);
    return false;
  }
  log.info('host-agent', `headroom + ONNX engines installed (${headroomPkg})`);

  onProgress('model');
  // ── Step 1b: pre-download the Kompress model so the first prompt isn't slow ─
  // The proxy eager-preloads the model at startup with allow_download=False and
  // DEFERS the ~840 MB download to the FIRST prompt on a cache miss — that
  // deferred download blows the agent's 90s idle timeout → "Thinking…" forever
  // on message 1. Warming the cache here moves the download to setup time. Two
  // separate HF repos are required: kompress-v2-base (the ONNX model; skip its
  // .pt/.safetensors torch artifacts) and ModernBERT-base (TOKENIZER ONLY —
  // Kompress loads its tokenizer from there; skip its model weights). Best-
  // effort: a download failure leaves Kompress to lazy-load later.
  const predownloadPy = [
    'from huggingface_hub import snapshot_download',
    'snapshot_download("chopratejas/kompress-v2-base", allow_patterns=["*.json","onnx/*.onnx","kompress-int8-wo.onnx"])',
    'snapshot_download("answerdotai/ModernBERT-base", allow_patterns=["*.json","tokenizer*","*.txt","vocab*","merges*"])',
  ].join('\n');
  const dl = await runner.run(py, ['-c', predownloadPy], {
    timeoutMs: ENGINE_INSTALL_TIMEOUT_MS,
  });
  log.info(
    'host-agent',
    dl.code === 0
      ? 'Kompress model pre-downloaded — first prompt will be fast'
      : 'Kompress model pre-download failed (best-effort) — first prompt may be slow',
  );

  // ── Step 2: `headroom init --global <agent>` (only when headroom is on PATH) ──
  // Verify headroom is on PATH before calling init; on some boxes pip installs
  // to a user-local directory that isn't on the current PATH yet.
  if (!runner.which('headroom')) {
    log.warn('host-agent', 'headroom not found on PATH after install — skipping init');
    return false;
  }
  // Map the incoming agent id (e.g. the LinkedAgentId `claude_code`) to the
  // subcommand kind `headroom init` accepts (`claude`/`codex`/`copilot`).
  const initKind = agentIdToHeadroomKind(agent);
  // Back up the agent's settings file before init overwrites it, so the user's
  // prior customisations can be restored later via restoreAgentHeadroomConfig.
  backupAgentHeadroomConfig(initKind);
  onProgress('init');
  // `headroom init --global claude` HARD-FAILS when no `claude` is on PATH.
  // On a self-hosted box claude is the SDK-bundled binary (never on PATH), so
  // prepend its dir to the init call's PATH. Init-call only — no global mutation.
  const initEnv = { ...process.env };
  if (initKind === 'claude') {
    const claudeDir = bundledClaudeBinDir();
    if (claudeDir) {
      initEnv.PATH = `${claudeDir}${path.delimiter}${process.env['PATH'] ?? ''}`;
      log.info('host-agent', `headroom init: bundled claude on PATH (${claudeDir})`);
    } else {
      log.warn('host-agent', 'headroom init: bundled claude binary not found — init may fail');
    }
  }
  const initResult = await runner.run('headroom', ['init', '--global', initKind], {
    env: initEnv,
  });
  const initOk = initResult.code === 0;
  if (!initOk) {
    const detail = initResult.stderr.replace(/\n+$/g, '');
    log.warn('host-agent', `headroom init failed (best-effort): ${detail}`);
  } else {
    const stdout = initResult.stdout ?? '';
    if (stdout.trim()) log.info('host-agent', `headroom init: ${stdout.trim()}`);
    log.info('host-agent', 'headroom init --global succeeded');
  }

  if (!initOk) {
    return false;
  }

  // ── Step 3: warm-start the proxy (detached, best-effort, don't await) ───
  // Pin Kompress to the ONNX CPU backend so it never tries to import torch
  // (absent by design). The proxy eager-preloads the pre-downloaded model from
  // cache at bind time, so the first prompt is compressed without a stall.
  onProgress('proxy');
  try {
    const proxyEnv = { ...process.env, HEADROOM_KOMPRESS_BACKEND: 'onnx_cpu' };
    const proxy = spawn(
      'headroom',
      ['proxy', '--port', '8787', ...buildBudgetProxyArgs(proxyEnv)],
      {
        stdio: 'ignore',
        detached: true,
        env: proxyEnv,
      },
    );
    // Consume the error event so Node doesn't throw an uncaught exception when
    // headroom is not on PATH (e.g. installed to a user-local dir not yet on
    // the current PATH). The outer try/catch only catches synchronous throws.
    proxy.once('error', (e) => {
      log.warn(
        'host-agent',
        `headroom proxy warm-start error (best-effort): ${e.message}`,
      );
    });
    proxy.unref(); // don't keep the supervisor process alive for the proxy
  } catch (e) {
    // Non-fatal — the SessionStart hook in settings.json also ensures the proxy.
    log.warn(
      'host-agent',
      `headroom proxy warm-start failed (best-effort): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  onProgress('ready');
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
 * The current running CLI version, read from the tsup-injected
 * `__CLI_VERSION__` constant (single source of truth — same one
 * `version.ts` uses). Returns `null` when the define wasn't applied (dev
 * tests via tsx) so the self-update compare treats it as "never newer".
 */
function currentCliVersion(): string | null {
  return typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : null;
}

/**
 * Outcome of one self-update check. `'updated'` means a strictly-newer
 * version was installed (the caller should restart). `'current'` means we
 * were already on the latest. `'skipped'` covers every best-effort failure
 * (registry/network/parse/install error) — the supervisor never crashes on
 * it. `version` carries the newly-installed version on `'updated'`.
 */
export interface SelfUpdateResult {
  status: 'updated' | 'current' | 'skipped';
  version?: string;
}

/**
 * Resolve the latest published version + self-update, injectable for tests.
 *
 * Contract: resolves to a {@link SelfUpdateResult}, NEVER rejects — every
 * failure maps to `'skipped'`. The default implementation shells out to npm
 * via {@link runSelfUpdate}; tests pass a deterministic mock so no real npm
 * runs and `process.exit` is never reached.
 */
export type SelfUpdater = () => Promise<SelfUpdateResult>;

/**
 * Run a command via execFile, resolving to `{ code, stdout, stderr }` on
 * completion/timeout — never rejects. Mirrors the best-effort, bounded
 * shape the Headroom runner uses. `cmd` is `npm` for the normal path and
 * `sudo` for the EACCES escalation retry (args then lead with `npm`).
 */
function runCmd(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      // execFile sets err.code to the exit status on a non-zero exit; on a
      // spawn error (npm missing) there's no numeric code — treat as null.
      const code =
        err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : err
            ? null
            : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/**
 * Default self-updater: check npm for a newer `codeam-cli`, install it, and
 * report whether the version actually changed. Pure best-effort — any
 * failure resolves `'skipped'` and is logged at warn; it NEVER rejects so
 * the supervisor's self-update tick can't crash the process.
 *
 * Steps:
 *   1. `npm view codeam-cli version` (30s) → latest published version.
 *   2. Compare to the running `__CLI_VERSION__` via `compareSemver`. If not
 *      strictly newer → `'current'` (no install).
 *   3. `npm install -g codeam-cli@latest` (180s). The systemd unit runs as
 *      root so a global install works; if it fails with EACCES AND we're
 *      not already root, retry once with a `sudo` prefix.
 *   4. On a successful install, re-resolve the installed version and return
 *      `'updated'` with it (the caller restarts so systemd relaunches new code).
 */
export async function runSelfUpdate(): Promise<SelfUpdateResult> {
  try {
    const current = currentCliVersion();
    if (!current) {
      // No build-time version (dev/tsx) — can't reason about "newer". Skip.
      log.trace('host-agent', 'self-update: no __CLI_VERSION__ — skipping');
      return { status: 'skipped' };
    }

    const view = await runCmd(
      'npm',
      ['view', SELF_UPDATE_PKG, 'version'],
      SELF_UPDATE_VIEW_TIMEOUT_MS,
    );
    if (view.code !== 0) {
      log.trace('host-agent', `self-update: npm view exited ${String(view.code)} — skipping`);
      return { status: 'skipped' };
    }
    const latest = view.stdout.trim();
    if (!latest) {
      log.trace('host-agent', 'self-update: empty npm view output — skipping');
      return { status: 'skipped' };
    }

    // Only update on a strictly-newer published version.
    if (compareSemver(latest, current) <= 0) {
      return { status: 'current' };
    }

    log.info('host-agent', `self-update: ${current} → ${latest} available — installing`);
    const installArgs = ['install', '-g', `${SELF_UPDATE_PKG}@latest`];
    let install = await runCmd('npm', installArgs, SELF_UPDATE_INSTALL_TIMEOUT_MS);

    // EACCES + not-root → retry once under sudo (the global prefix needs
    // escalation on a box where host-agent isn't root, e.g. a dev box).
    const isRoot = process.getuid?.() === 0;
    if (install.code !== 0 && !isRoot && /EACCES/i.test(install.stderr)) {
      log.info('host-agent', 'self-update: install hit EACCES — retrying with sudo');
      install = await runCmd('sudo', ['npm', ...installArgs], SELF_UPDATE_INSTALL_TIMEOUT_MS);
    }

    if (install.code !== 0) {
      log.warn(
        'host-agent',
        `self-update: install exited ${String(install.code)} — staying on ${current}`,
      );
      return { status: 'skipped' };
    }

    // Confirm the install actually changed the on-disk version before we
    // tell the supervisor to restart (guards against a no-op install).
    const after = await runCmd(
      'npm',
      ['view', SELF_UPDATE_PKG, 'version'],
      SELF_UPDATE_VIEW_TIMEOUT_MS,
    );
    const installed = after.code === 0 ? after.stdout.trim() || latest : latest;
    return { status: 'updated', version: installed };
  } catch (err) {
    // Defensive — runNpm never rejects, but guard so the tick never throws.
    log.warn(
      'host-agent',
      `self-update: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { status: 'skipped' };
  }
}

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
 * Default restart action after a successful self-update: log + exit 0 so
 * the systemd unit (`Restart=always`, `RestartSec=5`) relaunches the
 * process on the freshly-installed binary. Injectable so tests assert the
 * restart intent without killing the test runner.
 */
const defaultOnUpdated = (version: string): void => {
  log.info('host-agent', `self-update: installed ${version}, restarting`);
  process.exit(0);
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

/**
 * Best-effort Headroom teardown for `self_hosted_wipe` (full de-provision).
 *
 * The Headroom proxy is a per-HOST singleton on :8787, started detached +
 * unref'd with NO handle retained (by the supervisor warm-start and/or the
 * durable `headroom install` + SessionStart hook). The supervisor's normal
 * child teardown therefore never reaps it, so on a full de-provision it would
 * leak: keep holding :8787, keep a uvicorn master+worker alive, and keep
 * polling Anthropic subscription usage every 5 min. We must stop it explicitly.
 *
 * IMPORTANT: this runs ONLY on `self_hosted_wipe` (the whole host is being
 * removed), never on `self_hosted_stop` — the proxy is shared across all
 * sessions on the box, so killing it per-session would break the others.
 */
const defaultTeardownHeadroom = (): void => {
  // 1. Undo the durable integration first so a future agent start can't relaunch
  //    the proxy from the SessionStart hook / settings.json base URL.
  try {
    const kind = (JSON.parse(fs.readFileSync(headroomConfigPath(), 'utf8')) as { agent?: string })
      .agent;
    if (kind) {
      execFileSync('headroom', ['unwrap', kind], { stdio: 'ignore', timeout: 15_000 });
    }
  } catch {
    /* no config / headroom absent / unwrap unsupported — best-effort */
  }
  // 2. Stop the running proxy (no handle was kept). SIGTERM lets uvicorn flush
  //    its savings ledger and reap its own workers; pkill skips its own pid and
  //    matches both `headroom proxy …` and `python -m headroom.cli proxy …`.
  try {
    execFileSync('pkill', ['-TERM', '-f', 'headroom.*proxy'], { stdio: 'ignore' });
  } catch {
    /* pkill absent (non-Linux) or nothing matched — best-effort */
  }
  // 3. Mark the persisted config disabled so any stray resume can't point a
  //    child at the now-dead proxy.
  persistHeadroomConfig({ enabled: false });
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
   * Best-effort Headroom proxy teardown for `self_hosted_wipe`. Defaults to
   * {@link defaultTeardownHeadroom} (unwrap durable integration + kill the
   * orphaned proxy on :8787). Injectable so tests assert the wipe path without
   * running real pkill/headroom.
   */
  teardownHeadroom?: () => void;
  /**
   * Headroom setup function. Defaults to `setupHeadroomForSelfHosted`.
   * Injectable so tests mock away real pip/spawn without touching the file system.
   */
  setupHeadroom?: (agent: string) => Promise<boolean>;
  /**
   * Probe whether Headroom is ALREADY installed on this box (binary on PATH).
   * Defaults to a `which headroom` check. The disk gate uses it to bypass the
   * install-disk preflight for a box that already has Headroom — so a low-disk
   * reading never disables reporting on a proxy that's already running.
   * Injectable so tests drive the bypass without a real PATH lookup.
   */
  isHeadroomInstalled?: () => boolean;
  /**
   * Read free disk bytes for the install preflight. Defaults to
   * {@link getFreeDiskBytes}. Injectable so tests drive the disk gate
   * deterministically without depending on the host's real free space.
   */
  getFreeDisk?: (dir: string) => Promise<number | null>;
  /**
   * Periodic self-update check + install. Defaults to {@link runSelfUpdate}
   * (the real npm-backed updater). Injectable so tests assert the update
   * logic without touching real npm or `process.exit`.
   */
  selfUpdate?: SelfUpdater;
  /**
   * Called when a self-update installed a strictly-newer version and the
   * box is idle, so the new code can take over. Defaults to
   * `process.exit(0)` (systemd `Restart=always` relaunches the new binary).
   * Injectable so tests assert the restart WITHOUT killing the test runner.
   */
  onUpdated?: (version: string) => void;
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
  /** Probe whether Headroom is already installed (defaults to `which headroom`). */
  private readonly isHeadroomInstalled: () => boolean;
  /** Free-disk reader for the install preflight (defaults to getFreeDiskBytes). */
  private readonly getFreeDisk: (dir: string) => Promise<number | null>;
  private relay: Pick<CommandRelayService, 'start' | 'stop'> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Periodic self-update timer (npm check + install + restart). */
  private selfUpdateTimer: NodeJS.Timeout | null = null;
  /** Self-update check + install (injectable; defaults to runSelfUpdate). */
  private readonly selfUpdate: SelfUpdater;
  /** Restart action after a successful self-update (defaults to process.exit). */
  private readonly onUpdated: (version: string) => void;
  /** Guards against overlapping self-update ticks (a slow npm install). */
  private selfUpdating = false;
  /**
   * Set once a self-update installed a newer version but a child was busy,
   * so the next idle tick restarts WITHOUT re-installing. Carries the
   * already-installed version for the restart log.
   */
  private pendingRestartVersion: string | null = null;
  /** Guards the one-shot 'connected' telemetry on the first heartbeat. */
  private reportedConnected = false;
  /** Live-metrics collector — stateful across beats (CPU delta + latency). */
  private readonly metrics: HostMetricsCollector;
  /** Self-heal action when the backend rejects this identity. */
  private readonly onIdentityRejected: () => void;
  /** Best-effort systemd de-provision used by `self_hosted_wipe`. */
  private readonly disableService: () => void;
  private readonly teardownHeadroom: () => void;
  /** Guards against firing the self-heal more than once. */
  private healing = false;

  constructor(
    private readonly identity: SealedHostIdentity,
    private readonly deps: HostAgentDeps = {},
  ) {
    this.spawnChild = deps.spawnChild ?? defaultSpawner;
    this.resolveAgentAuth = deps.resolveAgentAuth ?? unsealAgentAuth;
    this.setupHeadroom = deps.setupHeadroom ?? setupHeadroomForSelfHosted;
    this.isHeadroomInstalled =
      deps.isHeadroomInstalled ?? (() => defaultHeadroomRunner.which('headroom'));
    this.getFreeDisk = deps.getFreeDisk ?? getFreeDiskBytes;
    this.metrics = deps.metricsCollector ?? new MetricsCollector();
    this.onIdentityRejected = deps.onIdentityRejected ?? defaultOnIdentityRejected;
    this.disableService = deps.disableService ?? defaultDisableService;
    this.teardownHeadroom = deps.teardownHeadroom ?? defaultTeardownHeadroom;
    this.selfUpdate = deps.selfUpdate ?? runSelfUpdate;
    this.onUpdated = deps.onUpdated ?? defaultOnUpdated;
  }

  /**
   * Resolve the self-update interval, honoring `CODEAM_HOST_SELF_UPDATE_MS`.
   * A finite value > 0 overrides the default; 0 or negative DISABLES the
   * periodic self-update (tests / pinned boxes); a non-numeric/absent value
   * falls back to {@link SELF_UPDATE_INTERVAL_MS}.
   */
  private selfUpdateIntervalMs(): number {
    const raw = process.env.CODEAM_HOST_SELF_UPDATE_MS;
    if (raw === undefined || raw === '') return SELF_UPDATE_INTERVAL_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return SELF_UPDATE_INTERVAL_MS;
    return parsed;
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

    // Boot reconcile: a fresh supervisor owns NO children yet (a restart /
    // crash / reboot killed any previous ones), so the authoritative live
    // set is whatever we currently supervise — empty at this point. Reporting
    // it ends any rows the backend still has marked active for this host,
    // clearing zombies that a hard crash left without an `ended` event.
    // One-shot, best-effort; the next boot re-converges if this POST fails.
    void reportSessionEvent(
      { hostId: this.identity.hostId, hostToken: this.identity.hostToken },
      { event: 'reconcile', activeDeployIds: this.activeSessions().map((s) => s.id) },
    ).catch((err) => log.trace('host-agent', 'boot reconcile failed (best-effort)', err));

    // Periodic self-update: check npm for a newer codeam-cli, install it,
    // and restart so systemd relaunches the new code. Best-effort; the
    // timer is unref'd so it never keeps the process alive on its own. A
    // non-positive interval (env opt-out / tests) disables it entirely.
    const updateMs = this.selfUpdateIntervalMs();
    if (updateMs > 0) {
      this.selfUpdateTimer = setInterval(() => void this.selfUpdateTick(), updateMs);
      this.selfUpdateTimer.unref?.();
    } else {
      log.info('host-agent', 'self-update disabled (CODEAM_HOST_SELF_UPDATE_MS<=0)');
    }

    log.info('host-agent', `supervisor up host=${this.identity.hostId.slice(0, 8)}`);
  }

  /** Stop the control channel + heartbeats + kill every child. */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.selfUpdateTimer) {
      clearInterval(this.selfUpdateTimer);
      this.selfUpdateTimer = null;
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
      // The heartbeat carries liveness + metrics ONLY. Session state is
      // event-driven (reportSessionEvent + the backend-owned START) — NOT
      // sampled here. Re-sending a discrete state every beat is polling.
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

  /**
   * One self-update tick. Best-effort + never crashes the supervisor: the
   * whole body is wrapped in try/catch and the injected updater never
   * rejects. Sequence:
   *
   *   1. If a restart is already PENDING (a prior tick installed a newer
   *      version while a child was busy), skip the npm work and just try to
   *      restart now — no re-install.
   *   2. Otherwise run the injected `selfUpdate`. On `'updated'`, remember
   *      the new version as pending; on anything else, do nothing.
   *   3. SAFETY: only restart when no child turn is in flight. If a child is
   *      mid-work, DEFER — the install already happened, so a later idle
   *      tick just restarts. (We prefer deferring to yanking an active turn;
   *      systemd would restart in ~5s but the mobile would drop the turn.)
   *
   * `selfUpdating` guards against a slow npm install overlapping the next
   * tick (the timer keeps firing on its interval).
   */
  async selfUpdateTick(): Promise<void> {
    if (this.selfUpdating) return;
    this.selfUpdating = true;
    try {
      // Fast path: a restart is already owed from a prior install — don't
      // re-run npm, just restart as soon as the box is idle.
      if (this.pendingRestartVersion !== null) {
        this.maybeRestartForUpdate(this.pendingRestartVersion);
        return;
      }

      const result = await this.selfUpdate();
      if (result.status !== 'updated') return;

      // A strictly-newer version is now installed on disk. Mark the restart
      // as owed, then restart if idle (else defer to the next idle tick).
      const version = result.version ?? 'latest';
      this.pendingRestartVersion = version;
      this.maybeRestartForUpdate(version);
    } catch (err) {
      // The updater contract is never-reject, but guard so a bug here can't
      // take down the long-lived supervisor.
      log.warn(
        'host-agent',
        `self-update tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.selfUpdating = false;
    }
  }

  /**
   * Restart for an already-installed update IFF no child turn is in flight.
   * When a child is busy we DEFER (the version stays pending for the next
   * idle tick) rather than yank an active turn.
   */
  private maybeRestartForUpdate(version: string): void {
    if (this.children.size > 0) {
      log.info(
        'host-agent',
        `self-update: ${version} installed but ${this.children.size} child(ren) busy — deferring restart`,
      );
      return;
    }
    this.onUpdated(version);
  }

  /** Number of live children — for tests + diagnostics. */
  childCount(): number {
    return this.children.size;
  }

  /**
   * Snapshot the supervisor's live children as heartbeat session entries.
   *
   * Each entry's `id` is the deployId-correlated sessionId the backend
   * recognizes (the supervisor keys its children by it — the same id a
   * `self_hosted_stop` arrives with, see `stopChild`). `agent` is the deploy's
   * `agentId`; `startedAt` is the epoch-ms spawn time tracked on the child.
   * Returns `[]` when no children are active so the backend reflects "0 active".
   */
  private activeSessions(): HostSession[] {
    return [...this.children.values()].map((child) => ({
      id: child.deployId,
      agent: child.agent,
      startedAt: child.startedAt,
    }));
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
    if (cmd.type === 'self_hosted_refresh_credentials') {
      if (!isRefreshCredentialsPayload(cmd.payload)) {
        log.warn('host-agent', `ignoring malformed self_hosted_refresh_credentials id=${cmd.id}`);
        return;
      }
      await this.refreshCredentials(cmd.payload);
      return;
    }
    if (cmd.type === 'self_hosted_wipe') {
      // The app deleted this host while it was ONLINE. Cleanly de-provision:
      // kill children, remove the sealed identity, best-effort disable the
      // systemd unit, then exit. (Disabling first means systemd won't simply
      // restart us into a cleanly-failing redeem.)
      log.warn('host-agent', `self_hosted_wipe received id=${cmd.id} — de-provisioning`);
      this.stop();
      // Reap the per-host Headroom proxy too — stop() only kills tracked
      // children, and the proxy is detached with no handle, so it would
      // otherwise leak (holds :8787, keeps uvicorn + subscription polling alive).
      this.teardownHeadroom();
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
        // Isolate the house agent's Claude config from the box's PERSONAL one.
        // A self-hosted box is reused and often already has a real
        // ~/.claude/.credentials.json + ~/.claude.json (oauthAccount) from the
        // user's own Claude login. Claude Code then prefers that stale OAuth
        // identity over our ANTHROPIC_AUTH_TOKEN proxy token and sends the wrong
        // credential to the CodeAgent Cloud proxy → 401. (Codespaces are fresh,
        // so they never hit this.) Point the house agent at a dedicated, empty
        // config dir so it boots clean in gateway mode (ANTHROPIC_AUTH_TOKEN +
        // the proxy) and NEVER touches the user's personal Claude login.
        const houseConfigDir = path.join(os.homedir(), '.codeam', 'house-claude');
        try {
          fs.mkdirSync(houseConfigDir, { recursive: true, mode: 0o700 });
        } catch {
          /* best-effort — claude will create it on first run */
        }
        childEnv.CLAUDE_CONFIG_DIR = houseConfigDir;
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

      // A self-hosted deploy is an AUTONOMOUS, headless session — the user
      // drives it from their phone, there's no human at the box to answer
      // tool-permission prompts. Mark it so the pair-auto child auto-approves
      // permissions (the agent-agnostic equivalent of the codespace
      // `CODESPACES=true` gate in `start.ts`), instead of stalling every turn
      // on a confirmation.
      childEnv = { ...childEnv, CODEAM_AUTO_APPROVE: '1' };

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

      // 1b2) GitHub `gh` CLI — a bare self-hosted box may have neither `gh`
      //      installed nor any GitHub account configured. Best-effort: install
      //      `gh` (official static binary, no root) if absent, then authenticate
      //      it with the user's token UNLESS the box already has a login (never
      //      clobber the user's own gh). Gated on a clone token (only meaningful
      //      for GitHub deploys). A failure NEVER blocks the deploy — `git pull`/
      //      `push` already work via the credential helper from prepareWorkspace.
      if (payload.cloneToken) {
        try {
          report('preparing', 'configuring git tooling');
          const ghCmd = await ensureGhCli(defaultGitToolingRunner, payload.cloneToken);
          if (ghCmd) {
            // Make the installed binary findable by the agent (OS-agnostic
            // PATH separator).
            childEnv.PATH = `${codeamBinDir()}${path.delimiter}${childEnv.PATH}`;
            await ensureGhAuth(defaultGitToolingRunner, ghCmd, payload.cloneToken);
          }
        } catch (e) {
          log.warn(
            'host-agent',
            `gh tooling setup skipped: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

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
      //     deploy. We PERSIST the result to ~/.codeam/headroom-config.json so a
      //     later resume / supervisor restart (systemd / periodic self-update)
      //     re-injects the same HEADROOM_* env from the persisted source of
      //     truth — reporting survives, not just on the fresh-deploy path. We
      //     only persist enabled:true when setup fully succeeded so a later
      //     resume never points the agent at a dead proxy.
      if (
        payload.headroomEnabled &&
        payload.headroomAgent &&
        payload.headroomSavingsIngestUrl &&
        isHeadroomSupportedAgent(payload.headroomAgent)
      ) {
        report('headroom', 'setting up Headroom proxy');
        // Disk preflight: Headroom's compression engines (CPU PyTorch + ML/AST
        // extras) need ~2 GB. On a host without the room, SKIP the install and
        // tell the user in the app rather than fill their disk — the agent
        // still runs, just without token-saving compression.
        const freeBytes = await this.getFreeDisk(os.homedir());
        // The disk gate is an INSTALL preflight — the ~1.5 GB of ONNX engines +
        // the Kompress model. A box where Headroom is ALREADY installed needs
        // none of that room to keep compressing + reporting, so a low-disk
        // reading must NOT disable an existing, working proxy. (Observed live:
        // a box compressing 22.8% had reporting silently turned off here —
        // free=2.0GB rounding under the 2GB gate — dropping real savings.)
        // setupHeadroom below is idempotent on an installed box: pip is a fast
        // "already satisfied" no-op and `headroom init` re-runs cleanly.
        const alreadyInstalled = this.isHeadroomInstalled();
        if (!alreadyInstalled && freeBytes !== null && freeBytes < HEADROOM_MIN_FREE_DISK_BYTES) {
          const freeGb = (freeBytes / 1e9).toFixed(1);
          const needGb = Math.round(HEADROOM_MIN_FREE_DISK_BYTES / 1e9);
          report(
            'headroom',
            `Token-saving optimizer skipped — needs ~${needGb} GB free, host has ${freeGb} GB. The agent runs normally without it.`,
          );
          log.warn(
            'host-agent',
            `Headroom skipped: insufficient disk (free=${freeGb}GB < ${needGb}GB)`,
          );
          persistHeadroomConfig({ enabled: false });
          // fall through to spawn the agent without Headroom
        } else {
          if (alreadyInstalled && freeBytes !== null && freeBytes < HEADROOM_MIN_FREE_DISK_BYTES) {
            log.info(
              'host-agent',
              `Headroom already installed — bypassing install disk gate (free=${(freeBytes / 1e9).toFixed(1)}GB); reporting stays enabled`,
            );
          }
          const headroomOk = await this.setupHeadroom(payload.headroomAgent);
          if (headroomOk) {
            // Use the mapped headroom kind (e.g. `claude_code` → `claude`) so the
            // persisted/env value matches what `headroom init` registered and what
            // the reporter reports as `dto.agentId` — consistent with codespaces,
            // which already report `claude`.
            persistHeadroomConfig({
              enabled: true,
              agent: agentIdToHeadroomKind(payload.headroomAgent),
              ingestUrl: payload.headroomSavingsIngestUrl,
            });
            log.info(
              'host-agent',
              'Headroom proxy ready; persisted headroom config for child spawns',
            );
          } else {
            // Setup failed → persist disabled so a later resume doesn't point the
            // agent at a dead proxy (and clears any stale enabled config).
            persistHeadroomConfig({ enabled: false });
            log.warn(
              'host-agent',
              'Headroom setup failed (best-effort) — child will run without Headroom',
            );
          }
        }
      } else if (payload.headroomEnabled === false) {
        // Feature explicitly turned off for this deploy — clear any stale
        // enabled config so a subsequent resume doesn't resurrect Headroom.
        persistHeadroomConfig({ enabled: false });
      } else if (payload.headroomEnabled && payload.headroomAgent && !isHeadroomSupportedAgent(payload.headroomAgent)) {
        // Headroom can't wrap this agent (e.g. gemini). Wrapping would mislaunch
        // it as the agentIdToHeadroomKind fallback (Claude), so disable Headroom
        // and let the agent run natively via its own runtime.
        log.info(
          'host-agent',
          `Headroom unsupported for agent '${payload.headroomAgent}' — running it natively (no wrap)`,
        );
        persistHeadroomConfig({ enabled: false });
      }

      // 2) Spawn the supervised `pair-auto` child. Routed through
      //    spawnSessionChild so the persisted HEADROOM_* env (the source of
      //    truth shared with any resume / restart spawn) is merged in one
      //    place — reporting survives every spawn, not just this one.
      report('spawning', 'starting agent');
      const proc = this.spawnSessionChild(childEnv, cwd, extraArgs);
      // Track by deployId now; the stop command uses sessionId, which the
      // backend correlates to this deploy (the control channel pushed the
      // stop with the session the child paired into).
      const child: ChildSession = {
        deployId: payload.deployId,
        proc,
        agent: payload.agentId,
        startedAt: Date.now(),
      };
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
        // END: a supervised child exited — report it one-shot so the backend
        // drops the active-sessions row (covers clean teardown AND crash;
        // a SIGTERM-stop also lands here). Discrete event, never a poll.
        if (tracked) {
          void reportSessionEvent(
            { hostId: this.identity.hostId, hostToken: this.identity.hostToken },
            { event: 'ended', deployId: payload.deployId },
          ).catch((err) =>
            log.trace('host-agent', 'session ended report failed (best-effort)', err),
          );
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
   * Spawn a supervised `pair-auto` session child, merging the persisted
   * Headroom env on top of the caller's env. This is the SINGLE spawn site for
   * session children: the fresh-deploy path and any future resume / restart
   * path both go through here, so the HEADROOM_* env (read from
   * `~/.codeam/headroom-config.json`, the source of truth a prior deploy wrote)
   * is injected on EVERY spawn — reporting survives session resumes and
   * supervisor restarts (systemd / periodic self-update), not just fresh
   * deploys. `readHeadroomChildEnv()` returns `{}` when Headroom is disabled or
   * was never set up, so this is a no-op there (never-break).
   */
  private spawnSessionChild(
    env: Record<string, string>,
    cwd: string,
    args: string[] = [],
  ): ChildProcess {
    return this.spawnChild({ ...env, ...readHeadroomChildEnv() }, cwd, args);
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
        log.warn(
          'host-agent',
          'agent install timed out (180s) — preview detection may be unavailable',
        );
        try {
          child.kill('SIGTERM');
        } catch {
          /* already dead */
        }
        done();
      }, 180_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          log.warn(
            'host-agent',
            `agent install exited code=${code} — preview detection may be unavailable; agent still runs`,
          );
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

  /**
   * Handle `self_hosted_refresh_credentials` (the user re-linked the agent).
   * Unseal the fresh credential and re-provision the agent's on-disk auth IN
   * PLACE (`provisionAgentCredentials` rewrites `~/.claude/.credentials.json`
   * etc.). The running pair-auto child re-reads its auth file on the next API
   * call, so a 401'd session recovers WITHOUT a restart — the self-hosted
   * parallel to the codespace `refreshAgentCredentialsOnly` sweep. Best-effort:
   * a failure is logged, never throws (the relay dispatch must not crash).
   */
  private async refreshCredentials(payload: RefreshCredentialsPayload): Promise<void> {
    try {
      const auth = await this.resolveAgentAuth(this.identity, payload.sealedAgentAuth);
      // Rewrites the agent's auth file (and returns env we don't need here —
      // the child reads the file, not our process env).
      provisionAgentCredentials(payload.agentId, auth, undefined);
      log.info(
        'host-agent',
        `refreshed credentials in place for agent=${payload.agentId} (${this.children.size} active child(ren))`,
      );
    } catch (err) {
      log.warn(
        'host-agent',
        `credential refresh failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
      // Terminal 4xx from the backend: the enroll token is permanently
      // unusable (expired, replayed, malformed, or bad signature). Do NOT
      // fall back to the sealed identity — the user explicitly ran the
      // installer to re-enroll, so a silent fall-back would leave them on
      // a stale/deleted host. Surface a clear message instead so they know
      // to generate a fresh token in the app.
      if (isTerminalEnrollError(err)) {
        throw new Error(
          'Enrollment token expired or invalid — generate a new one in the app ' +
            '(Settings › Servers › Add server). Tokens expire after 15 minutes and ' +
            'are single-use.',
          { cause: err },
        );
      }
      // Redeem failed for a transient reason (5xx, network blip, or a
      // plain service restart where the same token was already consumed).
      // Fall back to the sealed identity if we have one.
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

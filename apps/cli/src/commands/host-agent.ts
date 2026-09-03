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
 *      redeems the `CODEAM_ENROLL_TOKEN` on first run and seals it. Redeem
 *      also enrolls a proof-of-possession poll secret for the control plugin
 *      (`pluginSecretHash` on the redeem body; the raw secret sealed as
 *      `controlPollSecret`) so the control channel is command-ready the moment
 *      the host exists — a pushed `self_hosted_deploy` can't race ahead of
 *      poll-secret enrollment and get a `PLUGIN_SECRET_REQUIRED` ack 401.
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

import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CommandRelayService, type RemoteCommand } from '../services/command-relay.service';
import type { AgentMetadata, IntegrationsManifestEntry, SkillsManifestEntry } from '@codeam/shared';
import { resolveApiBaseUrl, getPricing } from '@codeam/shared';
import { persistIntegrationsManifest, clearIntegrationsManifest } from '../integrations/manifest';
import { persistOrClearSkillsFromPayload } from '../skills/persist-from-payload';

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
import { runAgentInstallScript } from './host/agent-install';
import { killQuiet } from '../lib/quiet';
import { getActiveSession, type SavedSession } from '../config';
import { installRelayCrashGuards } from '../lib/process-guards';
import {
  deleteHostIdentity,
  isHostAuthRejection,
  isTerminalEnrollError,
  loadHostIdentity,
  MetricsCollector,
  postSessionErrorBubble,
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
  type SessionBubbleAuth,
} from './host/host-client';
import {
  deployIdFromWorkspace,
  isAbsolutePathTarget,
  prepareWorkspace,
  selfHostedWorkspaceRoot,
} from './host/workspace';
import { provisionAgentCredentials } from './host/agent-provisioning';
import {
  ensureGhCli,
  ensureGhAuth,
  ensureGlabCli,
  ensureGlabAuth,
  defaultGitToolingRunner,
  codeamBinDir,
} from './host/git-tooling';
import {
  fetchWithTimeout,
  HeadroomStatsReporter,
  type Savings,
  type StatsShape,
} from '../services/headroom/stats-reporter';
import {
  ensureHeadroomProxyReady,
  makeRealProxySupervisorDeps,
} from '../services/headroom/proxy-supervisor';
import { defaultHeadroomRunner } from './host/os-packages';
import { encodeCwd } from '../agents/claude/history';
import {
  agentIdToHeadroomKind,
  getFreeDiskBytes,
  HEADROOM_MIN_FREE_DISK_BYTES,
  isHeadroomSupportedAgent,
  setupHeadroomForSelfHosted,
} from './host/headroom-bootstrap';
import {
  headroomConfigPath,
  persistHeadroomConfig,
  readHeadroomChildEnv,
  type HeadroomConfig,
} from './host/headroom-config';
import {
  persistHouseProxyConfig,
  clearHouseProxyConfig,
  readHouseProxyChildEnv,
  buildHouseProxyChildEnv,
} from './host/house-proxy-config';
import {
  runSelfUpdate,
  SELF_UPDATE_INTERVAL_MS,
  SELF_UPDATE_DEFER_MAX_MS,
  type SelfUpdater,
  type SelfUpdateResult,
} from './host/self-update';
import { defaultDisableService, defaultTeardownHeadroom } from './host/teardown';

// ── Re-exports (Phase 3 refactor) ──────────────────────────────────────────
// The implementations moved into commands/host/* modules; every symbol that
// host-agent.ts previously exported is re-exported here so external importers
// (start/handlers, services/headroom/configure, the headroom runner driver,
// and the test suites) keep their import paths unchanged.
export {
  detectPackageManager,
  ensureModernPython,
  resolveHeadroomPython,
  type HeadroomRunner,
  type PackageManager,
} from './host/os-packages';
export {
  agentIdToHeadroomKind,
  getFreeDiskBytes,
  isHeadroomSupportedAgent,
  setupHeadroomForSelfHosted,
  type HeadroomStep,
} from './host/headroom-bootstrap';
export {
  backupAgentHeadroomConfig,
  headroomConfigPath,
  persistHeadroomConfig,
  readHeadroomChildEnv,
  restoreAgentHeadroomConfig,
} from './host/headroom-config';
export {
  runSelfUpdate,
  SELF_UPDATE_DEFER_MAX_MS,
  type SelfUpdateResult,
  type SelfUpdater,
} from './host/self-update';

/** Liveness heartbeat cadence. State liveness only — NOT command polling. */
const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Bounded backoff for re-spawning a resumed session child that exits non-zero
 * (retry N waits RESUME_RETRY_BACKOFF_MS[N-1]): 5 total spawn attempts over
 * ~3.75 min. A transient failure (install race, half-written binary, network
 * blip) heals inside this window; a permanent one (agent binary genuinely
 * gone) exhausts it and falls through to the visible-error + slow re-probe
 * path below. Exported for the fake-clock tests.
 *
 * WHY (fleet-1, 2026-08-20): the v2.65.13 self-update restart resumed the
 * kimi session, the child died `ENOENT — 'kimi' was not found on PATH`, and
 * the supervisor gave up PERMANENTLY and SILENTLY — the HOST heartbeat stayed
 * online while the SESSION sat dead for 3+ hours with nothing in the chat.
 */
export const RESUME_RETRY_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000] as const;

/**
 * After the bounded retries exhaust, keep a SLOW periodic re-probe riding the
 * existing heartbeat tick (no new timers) so an externally-fixed cause (e.g.
 * the missing binary reinstalled / symlinked) heals the session WITHOUT
 * another manual restart. Exported for the fake-clock tests.
 */
export const RESUME_REPROBE_INTERVAL_MS = 5 * 60_000;

/**
 * A resumed child must stay alive this long before the retry state resets.
 * Without the age gate, a child that survives ONE heartbeat tick (20 s) would
 * refill the retry budget — a 25 s crash-loop would then retry silently
 * forever and never reach the visible-error path. Exported for the tests.
 */
export const RESUME_HEALTHY_AFTER_MS = 10 * 60_000;

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
        const res = await fetchWithTimeout('http://localhost:8787/stats');
        // res.json() returns unknown; cast at this validated boundary.
        return res.json() as Promise<StatsShape>;
      },
      postSavings: async (delta, budget) => {
        const res = await fetchWithTimeout(ingestUrl, {
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
              budgetReached: budget.budgetReached,
            } : {}),
          }),
        });
        if (!res.ok) {
          log.warn('headroom', `savings POST rejected ${res.status} — delta not credited`);
        }
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
        const res = await fetchWithTimeout('http://localhost:8787/stats');
        return res.json() as Promise<StatsShape>;
      },
      // Body MUST match HeadroomSavingsDto + PluginAuthGuard (sessionId +
      // pluginId in the body) — same shape as the codespace reporter above and
      // the on-demand `startReporter` in handlers.ts.
      postSavings: async (delta, budget) => {
        const res = await fetchWithTimeout(ingestUrl, {
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
              budgetReached: budget.budgetReached,
            } : {}),
          }),
        });
        if (!res.ok) {
          log.warn('headroom', `savings POST rejected ${res.status} — delta not credited`);
        }
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
  /**
   * OpenRouter (Model A): the gateway is the USER's OpenRouter (BYO endpoint +
   * key), not our house proxy. Do NOT pin the house MiniMax model — OpenRouter
   * routes the real Claude model names the agent sends. Absent/false ⇒ house.
   * Mirrors the backend `SelfHostedHouseProxy.openRouter`.
   */
  openRouter?: boolean;
}

/** The deploy command payload (mirrors the backend `SelfHostedDeployCommand`). */
interface DeployPayload {
  deployId: string;
  repoOrPath: string;
  /** Code host of `repoOrPath` when it's a repo — 'github' (default/absent)
   *  or 'gitlab'. Selects the clone URL scheme + which CLI (gh/glab) we set up. */
  repoProvider?: 'github' | 'gitlab';
  /** Git branch/ref to check out after cloning (e.g. a PR head branch for an
   *  agent PR review). Absent ⇒ the repo's default branch. */
  branch?: string;
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
  /**
   * Agent Toolkits integrations manifest for this deploy — the same shape
   * the codespace bootstrap writes to `~/.codeam/integrations.json`.
   * Persisted before the pair-auto child spawns so `start()` finds it
   * (see `persistIntegrationsManifest`/`buildMcpServersForStart`).
   * Absent or empty = no integrations wired for this deploy.
   */
  integrations?: IntegrationsManifestEntry[];
  /**
   * When true, this deploy auto-dispatches a task right after pairing (SFWI /
   * From-Conversation / Review / any confirm-launch), so the CLI's first-pair
   * onboarding welcome is noise → the child is spawned with
   * `CODEAM_ONBOARDING_DISABLED=1`. Absent/false = normal welcome. Mirrors the
   * classic-codespace bootstrap's `CODEAM_ONBOARDING_DISABLED` export.
   */
  suppressOnboardingWelcome?: boolean;
}

/** The stop command payload (mirrors the backend `SelfHostedStopCommand`). */
interface StopPayload {
  sessionId: string;
}

/**
 * The workspace-cleanup command payload (mirrors the backend
 * `SelfHostedCleanupCommand`). Pushed on session DELETE so a persistent box
 * doesn't accumulate one `~/.codeam/self-hosted/<deployId>` dir per deleted
 * session. Keyed by `deployId` — the dir is fully derivable from it.
 */
interface CleanupPayload {
  deployId: string;
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
  // repoProvider is optional (absent ⇒ github) but constrained when present.
  if (p.repoProvider !== undefined && p.repoProvider !== 'github' && p.repoProvider !== 'gitlab') {
    return false;
  }
  // branch is optional (absent ⇒ default branch); a string when present.
  if (p.branch !== undefined && typeof p.branch !== 'string') {
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
  if (
    p.suppressOnboardingWelcome !== undefined &&
    typeof p.suppressOnboardingWelcome !== 'boolean'
  ) {
    return false;
  }
  if (p.headroomSavingsIngestUrl !== undefined && typeof p.headroomSavingsIngestUrl !== 'string') {
    return false;
  }
  // integrations is optional (back-compat: older backends omit it); when
  // present it must be an array (entries aren't deep-validated here — the
  // manifest reader is defensive on read).
  if (p.integrations !== undefined && !Array.isArray(p.integrations)) {
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

function isCleanupPayload(
  p: Record<string, unknown>,
): p is CleanupPayload & Record<string, unknown> {
  return typeof p.deployId === 'string' && p.deployId.length > 0;
}

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
// above, deliberately NOT hoisted into `@codeam/shared`.

/** The `fleet_create_box` payload (mirrors backend `FleetCreateBoxCommand`). */
interface FleetCreateBoxPayload {
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

/** The `fleet_start_box` / `fleet_stop_box` / `fleet_delete_box` payload
 *  (mirrors backend `FleetBoxRefCommand`). */
/**
 * `fleet_migrate_box_image` — re-point a SLEEPING box at the current `:latest`
 * WITHOUT waking it. Backend shape: `FleetMigrateBoxImageCommand`.
 *
 * Deliberately has NO `enrollToken`, which is the difference that makes this
 * safe to apply in a batch. See `fleetMigrateBoxImage`.
 */
interface FleetMigrateBoxImagePayload {
  boxId: string;
  containerName: string;
  limits: FleetCreateBoxPayload['limits'];
  apiOrigin: string;
}

interface FleetBoxRefPayload {
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

function isFleetContainerName(v: unknown): v is string {
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

function isFleetCreateBoxPayload(
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

function isFleetMigrateBoxImagePayload(
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

function isFleetBoxRefPayload(
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
function fleetRefCanRecreate(
  p: FleetBoxRefPayload,
): p is FleetBoxRefPayload & Required<Pick<FleetBoxRefPayload, 'enrollToken' | 'apiOrigin' | 'limits'>> {
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
function isMissingContainerError(stderr: string): boolean {
  return /no such container/i.test(stderr);
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
 * holds every rescued user's data, so it does exactly two things and refuses to
 * be steered anywhere else:
 *   - `docker image prune` — DANGLING ONLY, never `-a`. Safe because Docker
 *     refuses to delete an image any container references, INCLUDING stopped
 *     ones.
 *   - `docker builder prune` — pure derived data.
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
interface FleetPruneHostPayload {
  images: boolean;
  buildCache: boolean;
}

function isFleetPruneHostPayload(v: unknown): v is FleetPruneHostPayload {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.images === 'boolean' && typeof p.buildCache === 'boolean';
}

/** Same idempotency treatment for `docker volume rm` on reap. */
function isMissingVolumeError(stderr: string): boolean {
  return /no such volume/i.test(stderr);
}

/**
 * Resolve the box image the fleet host runs. Host-side config, NEVER read
 * from the wire (the wire payload carries no image field — see
 * `FleetCreateBoxCommand`). Overridable with `CODEAM_FLEET_BOX_IMAGE` (the
 * real-Docker CI int test points this at its freshly-built local tag).
 */
function resolveFleetBoxImage(): string {
  return process.env.CODEAM_FLEET_BOX_IMAGE || 'ghcr.io/edgar-durand/codeam-box:latest';
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
function buildFleetBoxMigrateArgs(p: {
  boxId: string;
  containerName: string;
  apiOrigin: string;
  limits: FleetCreateBoxPayload['limits'];
}): string[] {
  return buildFleetBoxRunArgs(p)
    .map((a) => (a === 'run' ? 'create' : a))
    .filter((a) => a !== '--pull=always' && a !== '-d');
}

function buildFleetBoxRunArgs(p: {
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
 * handlers. Mirrors {@link HeadroomRunner} (`commands/host/os-packages.ts`):
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
const DOCKER_RUN_TIMEOUT_MS = 120_000;

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
const DOCKER_RUN_WITH_PULL_TIMEOUT_MS = 600_000;

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
      const timer = setTimeout(
        () => {
          if (settled) return;
          killQuiet(child);
        },
        opts.timeoutMs ?? DOCKER_RUN_TIMEOUT_MS,
      );
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
  // Synthetic control channel — capability flags are moot (no agent runs).
  headroomWrappable: false,
  acp: false,
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
 * Default RESUME spawner: bare `codeam` — resumes the last active session
 * (reconnects with the SAME pluginId via start(), then heartbeats). Used on
 * supervisor boot to bring the user's session back after a restart/self-update
 * without a manual reconnect. `CODEAM_AUTO_APPROVE=1` forces the ACP path and
 * keeps the local baton / native-TUI OFF (self-hosted + codespace sessions are
 * ACP-only), mirroring how a deploy child stays ACP via `CODEAM_AUTO_TOKEN`.
 */
const defaultResumeSpawner: ChildSpawner = (env, cwd) =>
  spawn(process.execPath, [process.argv[1]], {
    cwd,
    // CODEAM_AUTO_APPROVE=1 → ACP path (baton off). CODEAM_RESUME_LATEST=1 →
    // continue the user's most-recent conversation instead of opening an empty
    // one (runAcpSession loads it via the ACP session/list RPC).
    env: { ...process.env, ...env, CODEAM_AUTO_APPROVE: '1', CODEAM_RESUME_LATEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

/**
 * Default self-heal action when the backend rejects the host identity: this
 * identity can NEVER work again (the host was deleted server-side, or its
 * token revoked) — the box will fail every future redeem/heartbeat with the
 * exact same rejection. Disable the systemd unit FIRST (the same best-effort
 * `systemctl disable --now` the `self_hosted_wipe` de-provision path uses —
 * see `defaultDisableService`), THEN wipe the sealed identity and exit.
 *
 * Disabling here matters for the case where the host was deleted while this
 * box was OFFLINE and so never received the best-effort `self_hosted_wipe`
 * push: without it, `Restart=always` would just relaunch us straight back
 * into the same dead identity, forever (a P0 crash-loop, 2026-07). Calling
 * `defaultDisableService()` here is safe even when `self_hosted_wipe` already
 * disabled the unit moments earlier — it's idempotent and best-effort
 * (wrapped in its own try/catch).
 */
export const defaultOnIdentityRejected = (): void => {
  defaultDisableService();
  deleteHostIdentity();
  log.warn(
    'host-agent',
    'host identity rejected by backend — disabled service + wiped sealed identity, exiting',
  );
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

/** The slice of MetricsCollector the supervisor depends on (injectable for tests). */
export type HostMetricsCollector = Pick<MetricsCollector, 'collect' | 'recordLatency'>;

/** Dependencies the supervisor needs — all injectable for tests. */
export interface HostAgentDeps {
  spawnChild?: ChildSpawner;
  /** Injectable resume spawner (bare `codeam`) so tests don't fork. */
  resumeSpawner?: ChildSpawner;
  /**
   * Posts the visible "agent failed to restart" bubble into the session's
   * chat once the resume retries exhaust. Defaults to
   * {@link postSessionErrorBubble}; injectable so tests assert the message
   * without HTTP.
   */
  postResumeFailure?: (auth: SessionBubbleAuth, message: string) => Promise<void>;
  resolveAgentAuth?: AgentAuthResolver;
  /** Live-metrics collector; defaults to a real one. Injectable for tests. */
  metricsCollector?: HostMetricsCollector;
  /** Factory for the relay (lets tests assert subscription without HTTP). */
  makeRelay?: (
    pluginId: string,
    onCommand: (cmd: RemoteCommand) => void | Promise<void>,
    meta: AgentMetadata,
    /** Control-plugin proof-of-possession poll secret (sealed identity). */
    pollSecret?: string,
  ) => Pick<CommandRelayService, 'start' | 'stop' | 'sendResult'>;
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
   * Clock. Injectable so the self-update deferral CEILING is testable without
   * waiting a day. Defaults to `Date.now`.
   */
  now?: () => number;
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
  /**
   * Docker control-plane runner for the fleet `fleet_*` handlers (CodeAgent
   * Box rescue fleet). Additive — a normal self-hosted box never receives a
   * `fleet_*` command, so this stays dormant. Defaults to
   * {@link defaultDockerRunner} (a real `docker` subprocess). Injectable so
   * tests assert the exact argv without a Docker daemon.
   */
  docker?: DockerRunner;
}

/**
 * The supervisor. Holds the control channel + the live children. Exposed
 * as a class so tests can drive `handleCommand` directly and assert child
 * tracking without standing up the real relay.
 */
export class HostAgentSupervisor {
  private readonly children = new Map<string, ChildSession>();
  private readonly spawnChild: ChildSpawner;
  private readonly resumeSpawner: ChildSpawner;
  private readonly resolveAgentAuth: AgentAuthResolver;
  private readonly setupHeadroom: (agent: string) => Promise<boolean>;
  /** Probe whether Headroom is already installed (defaults to `which headroom`). */
  private readonly isHeadroomInstalled: () => boolean;
  /** Free-disk reader for the install preflight (defaults to getFreeDiskBytes). */
  private readonly getFreeDisk: (dir: string) => Promise<number | null>;
  private relay: Pick<CommandRelayService, 'start' | 'stop' | 'sendResult'> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Periodic self-update timer (npm check + install + restart). */
  private selfUpdateTimer: NodeJS.Timeout | null = null;
  /** Self-update check + install (injectable; defaults to runSelfUpdate). */
  private readonly selfUpdate: SelfUpdater;
  private readonly now: () => number;
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
  /** epoch ms when the CURRENT pending restart was first owed — the ceiling
   *  in {@link SELF_UPDATE_DEFER_MAX_MS} is measured from here. */
  private pendingRestartSince: number | null = null;
  /** Guards the one-shot 'connected' telemetry on the first heartbeat. */
  private reportedConnected = false;
  /** Live-metrics collector — stateful across beats (CPU delta + latency). */
  private readonly metrics: HostMetricsCollector;
  /** Self-heal action when the backend rejects this identity. */
  private readonly onIdentityRejected: () => void;
  /** Best-effort systemd de-provision used by `self_hosted_wipe`. */
  private readonly disableService: () => void;
  private readonly teardownHeadroom: () => void;
  /** Docker runner for the fleet `fleet_*` control-plane handlers. */
  private readonly docker: DockerRunner;
  /** Guards against firing the self-heal more than once. */
  private healing = false;
  /** Visible-error poster for the exhausted-resume path (injectable). */
  private readonly postResumeFailure: (
    auth: SessionBubbleAuth,
    message: string,
  ) => Promise<void>;
  /** How many resume re-spawns have failed since the last healthy child. */
  private resumeRetryAttempts = 0;
  /** Pending bounded-backoff resume retry (cleared on stop()). */
  private resumeRetryTimer: NodeJS.Timeout | null = null;
  /** Set once the bounded retries exhaust → heartbeat-ridden slow re-probe. */
  private resumeExhausted = false;
  /** Guards the one-shot visible error bubble per failure episode. */
  private resumeFailurePosted = false;
  /** Last slow re-probe attempt (epoch ms) — throttles the heartbeat rider. */
  private lastResumeReprobeAt = 0;
  /** True after stop() — no resume retries may be scheduled past teardown. */
  private stopped = false;

  constructor(
    private readonly identity: SealedHostIdentity,
    private readonly deps: HostAgentDeps = {},
  ) {
    this.spawnChild = deps.spawnChild ?? defaultSpawner;
    this.resumeSpawner = deps.resumeSpawner ?? defaultResumeSpawner;
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
    this.now = deps.now ?? (() => Date.now());
    this.onUpdated = deps.onUpdated ?? defaultOnUpdated;
    this.docker = deps.docker ?? defaultDockerRunner;
    this.postResumeFailure = deps.postResumeFailure ?? postSessionErrorBubble;
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
      ((pluginId, onCommand, meta, pollSecret) =>
        new CommandRelayService(pluginId, onCommand, meta, undefined, pollSecret));
    // Reuse the existing SSE-pull relay as the control channel — exactly
    // like a normal session, but subscribed on the host's controlPluginId.
    // Pass the sealed control-plugin poll secret so every /pending + /ack
    // carries `X-Plugin-Poll-Secret`; undefined for an identity sealed by a
    // pre-secret CLI (see the redeem note above).
    this.relay = make(
      this.identity.controlPluginId,
      (cmd) => this.handleCommand(cmd),
      CONTROL_AGENT_META,
      this.identity.controlPollSecret,
    );
    this.relay.start();

    // Liveness heartbeat (state, not command polling — the relay is the
    // command channel). Fire one immediately, then on the interval.
    void this.beat();
    this.heartbeatTimer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();

    // Auto-resume the user's session (2026-07-16 churn fix). Before this, a
    // restart / self-update killed the session child and NEVER re-spawned it
    // ("children are NOT auto-resumed (v1)"), so the user's chat went "CLI
    // disconnected" and they had to reconnect by hand — churn right after an
    // update. Re-spawn bare `codeam` (= resume the last active session:
    // reconnects with the SAME pluginId via start(), then heartbeats) so the
    // session comes back on its own, in its ORIGINAL ACP shape (self-hosted /
    // codespace sessions are ACP-only — CODEAM_AUTO_APPROVE keeps the baton /
    // native-TUI path OFF, exactly like a deploy child's CODEAM_AUTO_TOKEN).
    this.resumePersistedSession();

    // Proactively warm the Headroom proxy on boot/resume. A codespace resume /
    // container restart kills the detached :8787 proxy, and the resume path never
    // relaunches it (readHeadroomChildEnv re-injects only the ENV, pointing the
    // agent at a dead port), so the resumed session's FIRST turn would otherwise
    // fail "API Error: ConnectionRefused" (Rafael, 2026-08-08). ensureHeadroom-
    // ProxyReady no-ops when Headroom isn't configured; when it is + :8787 is
    // down it respawns + warms the ONNX model NOW, so the user's first message
    // doesn't pay the respawn latency mid-turn (the per-turn ensure in
    // AcpClient.runPrompt is the reactive belt; this is the proactive one).
    void ensureHeadroomProxyReady(makeRealProxySupervisorDeps()).catch(() => undefined);

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
    this.stopped = true;
    if (this.resumeRetryTimer) {
      clearTimeout(this.resumeRetryTimer);
      this.resumeRetryTimer = null;
    }
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
      killQuiet(child.proc);
    }
    this.children.clear();
  }

  private async beat(): Promise<void> {
    // Resume-recovery rider on the EXISTING heartbeat tick (no new timers,
    // and synchronous scheduling only — the beat must stay punctual): resets
    // the resume-retry state once a session child is alive again, and — after
    // the bounded retries exhausted — re-probes the resume on a slow throttle
    // so an externally-fixed cause heals without a manual restart.
    this.resumeRecoveryTick();
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
      // A restart already owed from a prior install: try it first — on a
      // healthy box this exits the process and nothing below runs.
      if (this.pendingRestartVersion !== null) {
        // On a healthy box `onUpdated` exits the process, but it is injectable
        // (and a no-op in tests), so stop here rather than falling through and
        // firing a second restart for the same version.
        if (this.maybeRestartForUpdate(this.pendingRestartVersion)) return;
      }

      // ⚠️ We keep checking even while a restart is owed. The old fast path
      // `return`ed here, so a box that could not restart ALSO stopped looking
      // for new versions — it stayed pinned to whatever was pending when the
      // first deferral happened, days-old by the time anyone noticed
      // (codeagent-e1uo). `selfUpdate` is a no-op `'current'` when there is
      // nothing newer, so this costs one registry lookup per hour, which the
      // non-pending path already paid anyway.
      const result = await this.selfUpdate();
      if (result.status !== 'updated') return;

      // A strictly-newer version is now installed on disk. Mark the restart
      // as owed, then restart if idle (else defer to the next idle tick).
      const version = result.version ?? 'latest';
      if (this.pendingRestartVersion === null) this.pendingRestartSince = this.now();
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
  private maybeRestartForUpdate(version: string): boolean {
    if (this.children.size > 0) {
      // ⚠️ `children` holds long-lived SESSION processes, not turns in flight
      // (a `ChildSession` carries no activity state at all), so on a paired
      // box this branch is the permanent state, not a transient one. Without a
      // ceiling "defer until idle" means "defer forever" — see
      // SELF_UPDATE_DEFER_MAX_MS.
      const since = this.pendingRestartSince ?? this.now();
      const waited = this.now() - since;
      if (waited < SELF_UPDATE_DEFER_MAX_MS) {
        log.info(
          'host-agent',
          `self-update: ${version} installed but ${this.children.size} child(ren) busy — deferring restart`,
        );
        return false;
      }
      log.warn(
        'host-agent',
        `self-update: ${version} has been owed for ${Math.round(waited / 3_600_000)}h with ` +
          `${this.children.size} child(ren) still running — restarting anyway rather than ` +
          'staying on old code',
      );
    }
    this.onUpdated(version);
    return true;
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
    // Fleet control plane (additive, CodeAgent Box rescue fleet). A normal
    // self-hosted box never receives these — they're only ever pushed to the
    // ONE host enrolled as the fleet host.
    if (cmd.type === 'fleet_create_box') {
      if (!isFleetCreateBoxPayload(cmd.payload)) {
        log.warn('host-agent', `ignoring malformed fleet_create_box id=${cmd.id}`);
        return;
      }
      await this.fleetCreateBox(cmd.payload);
      return;
    }
    if (cmd.type === 'fleet_migrate_box_image') {
      if (!isFleetMigrateBoxImagePayload(cmd.payload)) {
        log.warn('host-agent', `ignoring malformed fleet_migrate_box_image id=${cmd.id}`);
        return;
      }
      await this.fleetMigrateBoxImage(cmd.payload);
      return;
    }
    if (cmd.type === 'fleet_start_box') {
      if (!isFleetBoxRefPayload(cmd.payload)) {
        log.warn('host-agent', `ignoring malformed fleet_start_box id=${cmd.id}`);
        return;
      }
      await this.fleetStartBox(cmd.payload);
      return;
    }
    if (cmd.type === 'fleet_stop_box') {
      if (!isFleetBoxRefPayload(cmd.payload)) {
        log.warn('host-agent', `ignoring malformed fleet_stop_box id=${cmd.id}`);
        return;
      }
      await this.fleetStopBox(cmd.payload);
      return;
    }
    if (cmd.type === 'fleet_delete_box') {
      if (!isFleetBoxRefPayload(cmd.payload)) {
        log.warn('host-agent', `ignoring malformed fleet_delete_box id=${cmd.id}`);
        return;
      }
      await this.fleetDeleteBox(cmd.payload);
      return;
    }
    if (cmd.type === 'fleet_prune_host') {
      if (!isFleetPruneHostPayload(cmd.payload)) {
        log.warn('host-agent', `ignoring malformed fleet_prune_host id=${cmd.id}`);
        return;
      }
      await this.fleetPruneHost(cmd.payload);
      return;
    }
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
    if (cmd.type === 'self_hosted_cleanup') {
      if (!isCleanupPayload(cmd.payload)) {
        log.warn('host-agent', `ignoring malformed self_hosted_cleanup id=${cmd.id}`);
        return;
      }
      this.cleanupWorkspace(cmd.payload.deployId);
      return;
    }
    if (cmd.type === 'host_list_dir') {
      await this.listDir(cmd);
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
   * `host_list_dir` — read-only directory browse for the app's "Path on
   * server" picker (self-hosted deploy). Lists a directory on THIS host and
   * returns its subdirectories + files so the user can NAVIGATE to a project
   * path instead of guessing a raw one. NEVER writes, NEVER returns file
   * contents. It's the user's own box (auth already proved ownership at the
   * backend), so any absolute path is allowed; defaults to `$HOME`. Hidden
   * dot-entries are filtered (project paths are effectively never dotdirs).
   * Responds with a relay result the backend awaits.
   */
  private async listDir(cmd: RemoteCommand): Promise<void> {
    const relay = this.relay;
    if (!relay) return; // only reachable via the relay's onCommand — defensive
    const raw = (cmd.payload as { path?: unknown } | undefined)?.path;
    const target =
      typeof raw === 'string' && raw.trim() ? path.resolve(raw.trim()) : os.homedir();
    try {
      const dirents = await fs.promises.readdir(target, { withFileTypes: true });
      const entries = dirents
        .filter((d) => !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
        .sort((a, b) =>
          a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
        );
      const parent = path.dirname(target);
      await relay.sendResult(cmd.id, 'completed', {
        path: target,
        // null at the filesystem root so the UI can hide the ".." affordance.
        parent: parent === target ? null : parent,
        entries,
      });
    } catch (err) {
      await relay.sendResult(cmd.id, 'failed', {
        path: target,
        error: (err as NodeJS.ErrnoException).code ?? (err as Error).message,
      });
    }
  }

  /**
   * `fleet_create_box` — `docker run` a per-user rescue box. Builds the FULL
   * argv from a fixed template (Global Constraints — nothing from the wire
   * is passed through as a raw docker argument beyond the already-validated
   * `containerName` and the numeric resource limits): hard isolation
   * (`--cap-drop ALL`, `--security-opt no-new-privileges`, resource caps,
   * the isolated `fleet-net` network, a SINGLE named volume mounted at
   * `/home/box` — named identically to the container, per the Global
   * Constraints — and the ops labels). NEVER `--privileged`, NEVER a
   * `docker.sock` mount, NEVER a host bind mount. The api origin (not a
   * secret) is delivered via a normal `-e KEY=value`. The enroll token IS a
   * secret — spec invariant #1 is "token via env, NEVER argv" — so it is
   * delivered as a BARE `-e CODEAM_ENROLL_TOKEN` (no `=value`) with the
   * actual value passed only through {@link DockerRunner.run}'s `env` map,
   * which the runner merges into the `docker` CLI process's OWN env; docker
   * then reads a bare `-e NAME` from its own env and forwards it into the
   * container. The value never appears in the `docker run` argv, so it's
   * never visible via `ps` on the shared fleet host; never logged either.
   */
  private async fleetCreateBox(payload: FleetCreateBoxPayload): Promise<void> {
    const { containerName, limits } = payload;
    log.info(
      'host-agent',
      `fleet_create_box id=${payload.boxId} name=${containerName} ` +
        `mem=${limits.memoryMb}m cpus=${limits.cpus} pids=${limits.pidsLimit}`,
    );
    // Defensive: a DEAD same-name container (self_hosted_wipe exits the
    // box; RestartPolicy is "no") would make `docker run --name` fail
    // "name already in use" and wedge the box in PROVISIONING until the
    // backend's 15-min timeout sweep (the 2026-07-16 FLEET_RESCUE_FAILED
    // incident). The backend also dispatches fleet_delete_box before a
    // re-create, but a missed/failed delete must not wedge the create.
    // Name is already allowlist-validated; `rm` (no -v) NEVER touches the
    // box's named volume. "No such container" = nothing to clean = fine.
    const rm = await this.docker.run(['rm', '-f', containerName], {
      timeoutMs: DOCKER_RUN_TIMEOUT_MS,
    });
    if (rm.code !== 0 && !isMissingContainerError(rm.stderr)) {
      log.warn(
        'host-agent',
        `fleet_create_box: pre-create rm of ${containerName} failed (code=${rm.code}): ` +
          `${rm.stderr.trim().slice(-200)} — attempting run anyway`,
      );
    }
    const args = buildFleetBoxRunArgs(payload);
    const res = await this.docker.run(args, {
      // `--pull=always` pulls the ~1 GB image inline — needs the pull bound, not
      // the 120 s fast bound (which SIGTERM'd the create mid-pull, code=143).
      timeoutMs: DOCKER_RUN_WITH_PULL_TIMEOUT_MS,
      env: { CODEAM_ENROLL_TOKEN: payload.enrollToken },
    });
    if (res.code === 0) {
      // stdout is the created container id — not a secret, safe to log.
      log.info(
        'host-agent',
        `fleet box ${containerName} created (${res.stdout.trim().slice(0, 12)})`,
      );
    } else {
      log.warn(
        'host-agent',
        `fleet_create_box ${containerName} failed (code=${res.code}): ${res.stderr.trim().slice(-300)}`,
      );
    }
  }

  /** `fleet_start_box` — wake a sleeping box (`docker start`). Idempotent: a
   *  container the host already removed is treated as success. */
  /**
   * `fleet_migrate_box_image` — re-point a SLEEPING box at the current
   * `:latest` without waking it, so the version it was pinned to becomes
   * reclaimable by the (already automated) dangling-image prune.
   *
   * WHY THIS IS NEEDED AT ALL. Boxes are created with `--pull=always` on
   * purpose, so each stays pinned to the image it was born on, and Docker
   * refuses to delete an image any container references INCLUDING stopped
   * ones — which is precisely what stops the prune from destroying a sleeping
   * user's box. So every image release strands ~7.7 GB per lagging box until it
   * wakes or is reaped on day 7 (fleet-1, 2026-09-02: 9 boxes across 4
   * versions, ~31 GB held).
   *
   * ⚠️ THE HOST RE-CHECKS THAT THE BOX IS STOPPED, even though the backend only
   * selects `status: 'SLEEPING'`. The DB's view can lag the host by a sweep —
   * a box that woke seconds ago is still SLEEPING in the row — and re-creating
   * a RUNNING container kills a live agent mid-turn. The authority on whether a
   * container is running is the daemon, so we ask it here and refuse rather
   * than trust the payload.
   *
   * ⚠️ `docker create`, and NO enroll token. `run` would start the container,
   * so migrating the sleeping set in a batch would wake all of them (9 ×
   * 1536 MB on a 16 GB host) only for the sleep sweep to re-sleep them 30
   * minutes later. And a token would be a 15-minute credential baked into a
   * container that may not start for days — a terminal 4xx at boot, i.e. a box
   * that never comes back. The sealed identity is in the named volume, which
   * `rm` WITHOUT `-v` preserves.
   *
   * Idempotent and best-effort: a box already on `:latest` is skipped, a
   * missing container is success (a concurrent reap), and nothing here may
   * throw into the relay — this is housekeeping.
   */
  private async fleetMigrateBoxImage(payload: FleetMigrateBoxImagePayload): Promise<void> {
    const { containerName } = payload;

    // Authority check: the daemon, not the payload.
    const state = await this.docker.run([
      'inspect',
      '--format',
      '{{.State.Running}}',
      containerName,
    ]);
    if (state.code !== 0) {
      if (isMissingContainerError(state.stderr)) return; // reaped meanwhile
      log.warn(
        'host-agent',
        `fleet_migrate_box_image: inspect of ${containerName} failed (code=${state.code}) — skipping`,
      );
      return;
    }
    if (state.stdout.trim() === 'true') {
      log.info(
        'host-agent',
        `fleet_migrate_box_image: ${containerName} is RUNNING — skipping (never touch a live box)`,
      );
      return;
    }

    // Nothing to do when it already runs the freshest image. `fleetBoxImageStale`
    // pulls `:latest` first, so the pull happens ONCE here rather than per box
    // inside the create.
    if (!(await this.fleetBoxImageStale(containerName))) {
      log.info('host-agent', `fleet_migrate_box_image: ${containerName} already current`);
      return;
    }

    // rm WITHOUT -v → the named volume (workspace + sealed identity) survives.
    const rm = await this.docker.run(['rm', '-f', containerName], {
      timeoutMs: DOCKER_RUN_TIMEOUT_MS,
    });
    if (rm.code !== 0 && !isMissingContainerError(rm.stderr)) {
      log.warn(
        'host-agent',
        `fleet_migrate_box_image: rm of ${containerName} failed (code=${rm.code}): ` +
          `${rm.stderr.trim().slice(-200)} — NOT creating a replacement`,
      );
      return; // ⚠️ Bail. A create with the old container still present would
      // fail on the name clash and leave the box in neither state.
    }

    const res = await this.docker.run(buildFleetBoxMigrateArgs(payload), {
      timeoutMs: DOCKER_RUN_TIMEOUT_MS,
    });
    if (res.code !== 0) {
      log.warn(
        'host-agent',
        `fleet_migrate_box_image: create of ${containerName} failed (code=${res.code}): ` +
          `${res.stderr.trim().slice(-200)}`,
      );
      return;
    }
    log.info(
      'host-agent',
      `fleet_migrate_box_image: ${containerName} re-pointed at :latest (still stopped)`,
    );
  }

  private async fleetStartBox(payload: FleetBoxRefPayload): Promise<void> {
    const { containerName } = payload;
    // SELF-HEAL: when the backend sent recreate credentials (fresh token + api
    // origin + limits) AND the box's container is running a STALE image (or is
    // gone), RECREATE it from the current :latest instead of `docker start`ing
    // the old runtime. The named volume (workspace + sealed identity) is
    // preserved; a fresh enroll token makes `resolveHostIdentity` re-redeem so
    // the box picks up control-channel changes its old sealed identity lacked
    // (e.g. the poll secret). This is how a box created before a breaking
    // control-plane change heals on its next wake — without it, a wake reuses
    // the stale container forever (the 2026-07-24 poll-secret hang). A plain
    // wake (older backend, no creds) or a current image falls through to the
    // fast `docker start` path below.
    if (fleetRefCanRecreate(payload) && (await this.fleetBoxImageStale(containerName))) {
      log.info(
        'host-agent',
        `fleet_start_box id=${payload.boxId} name=${containerName} — image stale → recreating from :latest`,
      );
      // rm WITHOUT -v → the named volume (and the user's workspace) survives.
      const rm = await this.docker.run(['rm', '-f', containerName], {
        timeoutMs: DOCKER_RUN_TIMEOUT_MS,
      });
      if (rm.code !== 0 && !isMissingContainerError(rm.stderr)) {
        log.warn(
          'host-agent',
          `fleet_start_box: pre-recreate rm of ${containerName} failed (code=${rm.code}): ` +
            `${rm.stderr.trim().slice(-200)} — attempting run anyway`,
        );
      }
      const args = buildFleetBoxRunArgs({
        boxId: payload.boxId,
        containerName,
        apiOrigin: payload.apiOrigin,
        limits: payload.limits,
      });
      const res = await this.docker.run(args, {
        // Recreate also pulls `:latest` inline — use the pull bound, not 120 s.
        timeoutMs: DOCKER_RUN_WITH_PULL_TIMEOUT_MS,
        env: { CODEAM_ENROLL_TOKEN: payload.enrollToken },
      });
      if (res.code === 0) {
        log.info(
          'host-agent',
          `fleet box ${containerName} recreated from :latest (${res.stdout.trim().slice(0, 12)})`,
        );
      } else {
        log.warn(
          'host-agent',
          `fleet_start_box recreate ${containerName} failed (code=${res.code}): ${res.stderr.trim().slice(-300)}`,
        );
      }
      return;
    }

    // Fast path — image current (or no recreate creds / local-image override):
    // just wake the existing container. Idempotent: a container the host already
    // removed is treated as success.
    log.info('host-agent', `fleet_start_box id=${payload.boxId} name=${containerName}`);
    const res = await this.docker.run(['start', containerName]);
    if (res.code !== 0 && !isMissingContainerError(res.stderr)) {
      log.warn(
        'host-agent',
        `fleet_start_box ${containerName} failed (code=${res.code}): ${res.stderr.trim().slice(-300)}`,
      );
    }
  }

  /**
   * True when the box's container was created from an image OTHER than the
   * current registry `:latest` (a stale runtime), or the container is gone.
   * Pulls `:latest` first so the comparison is against the freshest image.
   * Best-effort + fail-SAFE: a local-image override (int test / operator) or any
   * pull/inspect error returns false → the caller falls back to a plain
   * `docker start`, so a transient docker hiccup can never wedge a wake.
   */
  private async fleetBoxImageStale(containerName: string): Promise<boolean> {
    // A CODEAM_FLEET_BOX_IMAGE override is a local-only tag that can't be
    // pulled/compared — never recreate under it.
    if (process.env.CODEAM_FLEET_BOX_IMAGE) return false;
    const image = resolveFleetBoxImage();
    // The image id the container currently runs.
    const cur = await this.docker.run(['inspect', '--format', '{{.Image}}', containerName]);
    if (cur.code !== 0) {
      // Missing container → recreate; any other inspect error → play it safe.
      return isMissingContainerError(cur.stderr);
    }
    // Pull so the local :latest reflects the registry before comparing.
    const pull = await this.docker.run(['pull', image], { timeoutMs: DOCKER_RUN_TIMEOUT_MS });
    if (pull.code !== 0) return false;
    const latest = await this.docker.run(['inspect', '--format', '{{.Id}}', image]);
    if (latest.code !== 0) return false;
    return cur.stdout.trim() !== '' && cur.stdout.trim() !== latest.stdout.trim();
  }

  /** `fleet_stop_box` — sleep an idle box (`docker stop`). MUST be
   *  idempotent — the backend's reap sweeps may re-send a stop for a box
   *  the host already stopped/removed; "No such container" is success. */
  /**
   * `fleet_prune_host` — reclaim Docker residue. Best-effort and idempotent: a
   * prune with nothing to collect exits 0 with "Total reclaimed space: 0B".
   *
   * ⚠️ Only ever `image prune` (dangling) and `builder prune`. NEVER
   * `container prune` (a stopped fleet container is a SLEEPING BOX) and NEVER
   * `volume prune` (a box's volume is the user's workspace and outlives its
   * container by design). See `FleetPruneHostPayload`.
   */
  private async fleetPruneHost(payload: FleetPruneHostPayload): Promise<void> {
    log.info(
      'host-agent',
      `fleet_prune_host images=${payload.images} buildCache=${payload.buildCache}`,
    );
    // `-f` only skips the interactive confirmation; it does not widen scope.
    const steps: Array<{ label: string; args: string[] }> = [];
    if (payload.images) steps.push({ label: 'image', args: ['image', 'prune', '-f'] });
    if (payload.buildCache) steps.push({ label: 'builder', args: ['builder', 'prune', '-f'] });

    for (const step of steps) {
      const res = await this.docker.run(step.args);
      if (res.code !== 0) {
        log.warn(
          'host-agent',
          `fleet_prune_host ${step.label} failed (code=${res.code}): ${res.stderr.trim().slice(-300)}`,
        );
        continue;
      }
      // The rail returns no result to the backend, so the freed total is only
      // ever visible here — worth logging, it is the only record.
      const reclaimed = /Total reclaimed space:\s*(.+)/i.exec(res.stdout || '');
      log.info(
        'host-agent',
        `fleet_prune_host ${step.label} ok${reclaimed ? ` reclaimed=${reclaimed[1].trim()}` : ''}`,
      );
    }
  }

  private async fleetStopBox(payload: FleetBoxRefPayload): Promise<void> {
    log.info('host-agent', `fleet_stop_box id=${payload.boxId} name=${payload.containerName}`);
    const res = await this.docker.run(['stop', payload.containerName]);
    if (res.code !== 0 && !isMissingContainerError(res.stderr)) {
      log.warn(
        'host-agent',
        `fleet_stop_box ${payload.containerName} failed (code=${res.code}): ${res.stderr.trim().slice(-300)}`,
      );
    }
  }

  /** `fleet_delete_box` — `docker rm -f`, plus `docker volume rm` when the
   *  backend asks for a reap (`removeVolume`). MUST be idempotent — deleting
   *  an already-gone container/volume is success, never a failure. */
  private async fleetDeleteBox(payload: FleetBoxRefPayload): Promise<void> {
    log.info(
      'host-agent',
      `fleet_delete_box id=${payload.boxId} name=${payload.containerName} ` +
        `removeVolume=${Boolean(payload.removeVolume)}`,
    );
    const res = await this.docker.run(['rm', '-f', payload.containerName]);
    if (res.code !== 0 && !isMissingContainerError(res.stderr)) {
      log.warn(
        'host-agent',
        `fleet_delete_box ${payload.containerName} failed (code=${res.code}): ${res.stderr.trim().slice(-300)}`,
      );
    }
    if (payload.removeVolume) {
      const volRes = await this.docker.run(['volume', 'rm', payload.containerName]);
      if (volRes.code !== 0 && !isMissingVolumeError(volRes.stderr)) {
        log.warn(
          'host-agent',
          `fleet_delete_box volume rm ${payload.containerName} failed (code=${volRes.code}): ${volRes.stderr.trim().slice(-300)}`,
        );
      }
    }
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
      const cwd = await prepareWorkspace(
        payload.repoOrPath,
        payload.deployId,
        payload.cloneToken,
        payload.repoProvider ?? 'github',
        payload.branch,
      );

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
        const { baseUrl, token, agentKind, openRouter } = payload.houseProxy;
        // ⚠️ ONE builder for the house env — this used to be a hand-copied
        // duplicate of `buildHouseProxyChildEnv`, and the two drifted: the
        // deploy path here kept setting only `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
        // (which can only SHRINK claude's assumed window) while the fix that
        // stops autocompact thrashing on MiniMax lives in
        // `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. Deploy, resume and in-session switch
        // now all get the exact same env. See house-proxy-config.ts.
        childEnv = {
          ...buildHouseProxyChildEnv({ baseUrl, token, openRouter: openRouter === true }),
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
        // ⚠️ Multi-session: isolate the config dir PER DEPLOY. Two concurrent
        // house sessions on one box each run their own Claude — a SHARED
        // house-claude dir would make them contend on Claude's mutable config
        // (`.claude.json` project state, `settings.json`), which can corrupt or
        // cross-wire the two sessions. A per-deploy dir keeps each isolated (and
        // each still boots clean in gateway mode via ANTHROPIC_AUTH_TOKEN).
        const houseConfigDir = path.join(
          os.homedir(),
          '.codeam',
          'house-claude',
          payload.deployId,
        );
        try {
          fs.mkdirSync(houseConfigDir, { recursive: true, mode: 0o700 });
        } catch {
          /* best-effort — claude will create it on first run */
        }
        childEnv.CLAUDE_CONFIG_DIR = houseConfigDir;
        extraArgs = [`--agent=${agentKind || 'claude'}`];
        // Persist the house-proxy env so a RESUME after a codespace sleep/wake
        // (or a supervisor restart) re-injects it — otherwise the woken bare
        // `codeam` resume had no ANTHROPIC_BASE_URL/AUTH_TOKEN and every prompt
        // failed with "Authentication required" (Rafael, 2026-08-05). Mirrors
        // the Headroom `persistHeadroomConfig` → `readHeadroomChildEnv` pattern.
        persistHouseProxyConfig({
          baseUrl,
          token,
          openRouter: !!openRouter,
          claudeConfigDir: houseConfigDir,
        });
      } else {
        // Non-house path: `sealedAgentAuth` is guaranteed present by
        // isDeployPayload (exactly one of houseProxy / sealedAgentAuth).
        const auth = await this.resolveAgentAuth(this.identity, payload.sealedAgentAuth!);
        const credEnv = provisionAgentCredentials(payload.agentId, auth, undefined);
        childEnv = {
          ...credEnv,
          CODEAM_AUTO_TOKEN: payload.autoPairToken,
        };
        // A BYO-credential deploy takes over the box — drop any persisted
        // house-proxy env so a later RESUME can't re-inject a stale house proxy
        // on top of this agent's own credential.
        clearHouseProxyConfig();
      }

      // A self-hosted deploy is an AUTONOMOUS, headless session — the user
      // drives it from their phone, there's no human at the box to answer
      // tool-permission prompts. Mark it so the pair-auto child auto-approves
      // permissions (the agent-agnostic equivalent of the codespace
      // `CODESPACES=true` gate in `start.ts`), instead of stalling every turn
      // on a confirmation.
      childEnv = { ...childEnv, CODEAM_AUTO_APPROVE: '1' };

      // ⚠️ Multi-session: mark this child as supervised so `pairAuto` SKIPS the
      // box-wide "one pair-auto per box" singleton lock. The supervisor spawns
      // one child per deploy (each a distinct session); the singleton would make
      // the 2nd+ concurrent deploy defer + exit(0) before claiming — only ONE
      // session would ever survive (the warm-codespace multi-session bug). Each
      // child is still protected against a duplicate of its OWN session by the
      // per-session daemon lock in start().
      childEnv = { ...childEnv, CODEAM_HOST_AGENT_CHILD: '1' };

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
          if ((payload.repoProvider ?? 'github') === 'gitlab') {
            // GitLab deploy → install + authenticate `glab` so the agent can
            // run `glab mr ...` against the cloned project.
            const glabCmd = await ensureGlabCli(defaultGitToolingRunner);
            if (glabCmd) {
              childEnv.PATH = `${codeamBinDir()}${path.delimiter}${childEnv.PATH}`;
              await ensureGlabAuth(defaultGitToolingRunner, glabCmd, payload.cloneToken);
            }
          } else {
            const ghCmd = await ensureGhCli(defaultGitToolingRunner, payload.cloneToken);
            if (ghCmd) {
              // Make the installed binary findable by the agent (OS-agnostic
              // PATH separator).
              childEnv.PATH = `${codeamBinDir()}${path.delimiter}${childEnv.PATH}`;
              await ensureGhAuth(defaultGitToolingRunner, ghCmd, payload.cloneToken);
            }
          }
        } catch (e) {
          log.warn(
            'host-agent',
            `git tooling setup skipped: ${e instanceof Error ? e.message : String(e)}`,
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

      // 1d) Task-launch deploys (SFWI / From-Conversation / Review) auto-dispatch
      //     start_task after pairing, so the first-pair onboarding welcome is
      //     noise — suppress it, same as the classic-codespace bootstrap's
      //     CODEAM_ONBOARDING_DISABLED export. The child's onboarding seam reads
      //     this env; the welcome marker is also written so a supervisor RESUME
      //     (which respawns without this flag) still skips it.
      if (payload.suppressOnboardingWelcome) {
        childEnv.CODEAM_ONBOARDING_DISABLED = '1';
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

      // 1e) Agent Toolkits integrations manifest — mirrors the codespace
      //     bootstrap write so the pair-auto child's `start()` (which reads
      //     `~/.codeam/integrations.json` via `buildMcpServersForStart`)
      //     finds the same file regardless of surface. Best-effort (both
      //     helpers swallow their own errors) and never blocks the deploy.
      if (payload.integrations?.length) {
        persistIntegrationsManifest({ integrations: payload.integrations });
      } else {
        clearIntegrationsManifest();
      }

      // 1f) Agent Skills manifest — same mirror-the-codespace-bootstrap
      //     pattern as 1e above, writing `~/.codeam/skills.json` before the
      //     pair-auto child's `start()` (which reads it via
      //     `provisionSkillsForStart`) spawns. Best-effort, never blocks the
      //     deploy. `DeployPayload` doesn't declare `skills` yet (backend
      //     field lands separately), hence the typed cast.
      persistOrClearSkillsFromPayload(
        (payload as { skills?: SkillsManifestEntry[] }).skills,
      );

      // 1g) Conversation continuity across a warm reconnect. The backend now
      //     derives a STABLE deployId per (host, repo, branch), so a plain
      //     re-launch lands back in the SAME workspace `cwd`. But `client.start()`
      //     always mints a FRESH ACP session — a stable cwd ALONE still opens an
      //     empty chat and strands the prior conversation. So when a prior
      //     conversation already exists in this cwd's namespace, resume the
      //     latest one (CODEAM_RESUME_LATEST, same mechanism as the wake path).
      //     Gated to a PLAIN re-launch: a task-dispatch deploy (PR review /
      //     work-item / conversation — `suppressOnboardingWelcome`) wants a
      //     focused fresh session, and PR reviews are already branch-isolated by
      //     the deployId key. A FIRST deploy has no prior → stays fresh. The
      //     runner's handler is best-effort (resume latest OTHER, else keep
      //     fresh), so this never breaks a deploy. (Rafael/Stefano "history gone
      //     on reconnect", 2026-08-06.)
      if (!payload.suppressOnboardingWelcome) {
        try {
          const cfgDir = childEnv.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
          const projectDir = path.join(cfgDir, 'projects', encodeCwd(cwd));
          const hasPriorConversation =
            fs.existsSync(projectDir) &&
            fs.readdirSync(projectDir).some((f) => f.endsWith('.jsonl'));
          if (hasPriorConversation) {
            childEnv.CODEAM_RESUME_LATEST = '1';
            log.info(
              'host-agent',
              `deploy: prior conversation in ${projectDir} — resuming latest for continuity`,
            );
          }
        } catch {
          /* best-effort — a detection failure just means a fresh session, never a broken deploy */
        }
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

      // ⚠️ A spawn that fails to EXEC (bad path, resource limit, EAGAIN fork)
      // emits 'error', NOT 'exit' — without this handler that child dies
      // SILENTLY: the map entry leaks (the supervisor thinks the session is
      // live) and the backend never sees a 'failed'. Report it + reap the map
      // exactly like an early exit. (2026-07-25: surfaced while debugging warm-
      // codespace multi-session — the real cause was the daemon-lock collision
      // below, but a silent spawn 'error' would mask any future failure the same
      // way, so both are fixed.)
      proc.once('error', (err) => {
        const tracked = this.children.get(payload.deployId)?.proc === proc;
        if (tracked) this.children.delete(payload.deployId);
        if (tracked) {
          report('failed', `agent failed to start: ${err instanceof Error ? err.message : String(err)}`);
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
   * Auto-resume the user's last active session on supervisor boot (2026-07-16
   * churn fix). Before this, a restart / self-update killed the session child
   * and never re-spawned it — the session lost its heartbeat, went "CLI
   * disconnected", and the user had to reconnect by hand (churn right after an
   * update). Spawn bare `codeam` via the resume spawner (reconnects the SAME
   * pluginId via start(), then heartbeats) so the session comes back on its own
   * in its ORIGINAL ACP shape (self-hosted/codespace = ACP-only; the resume
   * spawner sets CODEAM_AUTO_APPROVE=1 to keep the local baton/native-TUI OFF).
   *
   * Best-effort + guarded: no-op when there's no persisted session, when the
   * persisted session lacks the reconnect material (pluginId + pollSecret +
   * agent), or when a fresh deploy already owns a child this boot.
   */
  private resumePersistedSession(): void {
    try {
      if (this.children.size > 0) return; // a fresh deploy already owns a child
      const session = getActiveSession();
      if (!session || !session.pluginId || !session.pollSecret || !session.agent) return;

      // ⚠️ Resume in the SESSION's original deploy workspace, not the
      // host-agent's own cwd. On a warm codespace the host-agent runs in the
      // wrapper repo root (`/workspaces/<wrapper>`), while the session's agent +
      // its conversation live under the deploy workspace (`~/.codeam/self-hosted/
      // <deployId>`). Resuming in the wrong cwd made CODEAM_RESUME_LATEST find no
      // prior conversation → a fresh empty session with no project context
      // (2026-07-29). Fall back to process.cwd() for older sessions with no
      // persisted cwd (prior behavior).
      const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : process.cwd();
      // Re-inject BOTH the Headroom env AND the house-proxy env
      // (ANTHROPIC_BASE_URL + AUTH_TOKEN + model pins + CLAUDE_CONFIG_DIR). The
      // resume is a bare `codeam` that does NOT re-process the deploy, so
      // without this the house agent woke without its proxy auth → every prompt
      // failed locally with "Authentication required" (Rafael, 2026-08-05).
      // Returns `{}` when the box has no persisted house config (BYO deploy →
      // its own credential path is used instead).
      const proc = this.resumeSpawner(
        { ...readHeadroomChildEnv(), ...readHouseProxyChildEnv() },
        cwd,
      );
      // ⚠️ The child MUST be registered under its DEPLOY id, never the
      // paired-session id. `deployId` is the key every upward signal is matched
      // against server-side: the boot reconcile below reports it, and
      // `recordSessionEvent` compares it to `SelfHostedSession.deployId`. Using
      // `session.id` (a PairedSession id) reported an id from the WRONG SPACE,
      // so no row matched, the backend read the live session as unlisted, and
      // ENDED its link — moments after this very function resumed it. That row
      // is the only thing tying the session to its host, so the app then showed
      // a live CodeAgent Box session as **LOCAL** with a reconnect the user
      // cannot perform (they have no shell on our VPS). Reported by
      // rafaelph90.br@gmail.com 2026-09-01 and again 2026-09-02, by which point
      // 9 of 16 fleet boxes had lost their link this way.
      //
      // `SavedSession` doesn't persist the deployId, but it persists the deploy
      // WORKSPACE (`~/.codeam/self-hosted/<deployId>`), so the id is the
      // basename. Fall back to `session.id` only when the cwd isn't a deploy
      // workspace (a local pairing has no deployId at all) — there the backend
      // has no link row to protect either way.
      const deployId = deployIdFromWorkspace(session.cwd) ?? session.id;
      const child: ChildSession = {
        deployId,
        proc,
        agent: session.agent,
        startedAt: Date.now(),
      };
      this.children.set(deployId, child);

      let tail = '';
      const appendTail = (buf: Buffer): void => {
        tail = (tail + buf.toString('utf8')).slice(-2_000);
      };
      proc.stdout?.on('data', appendTail);
      proc.stderr?.on('data', appendTail);
      proc.once('exit', (code) => {
        if (this.children.get(deployId)?.proc === proc) this.children.delete(deployId);
        if (typeof code === 'number' && code !== 0) {
          this.onResumeChildExit(session, code, tail.trim().slice(-300));
        }
      });
      log.info(
        'host-agent',
        `resumed session ${session.id.slice(0, 8)} pluginId=${session.pluginId.slice(0, 12)} (ACP)` +
          (this.resumeRetryAttempts > 0 ? ` [retry ${this.resumeRetryAttempts}]` : ''),
      );
    } catch (err) {
      log.warn(
        'host-agent',
        `resume persisted session failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * A resumed session child died with a non-zero exit. Before 2026-08-20 this
   * was ONE warn log and permanent, silent surrender: the v2.65.13 self-update
   * restarted the fleet-1 unit, the resumed kimi child died `ENOENT — 'kimi'
   * was not found on PATH`, and the session sat dead for 3+ hours while the
   * HOST heartbeat stayed green (nothing retried, nothing surfaced anywhere).
   * Now: bounded backoff retries ({@link RESUME_RETRY_BACKOFF_MS}); when they
   * exhaust, post an HONEST error bubble into the session's chat (the relay/
   * backend are up — only the agent child is dead) and hand off to the
   * heartbeat-ridden slow re-probe ({@link resumeRecoveryTick}) so an
   * externally-fixed cause heals without a manual restart.
   */
  private onResumeChildExit(session: SavedSession, code: number, detail: string): void {
    if (this.stopped) return;
    const reason = detail ? `exit ${code}: ${detail}` : `exit ${code}`;
    if (this.resumeRetryAttempts < RESUME_RETRY_BACKOFF_MS.length) {
      const delay = RESUME_RETRY_BACKOFF_MS[this.resumeRetryAttempts];
      this.resumeRetryAttempts += 1;
      log.warn(
        'host-agent',
        `resumed session ${session.id.slice(0, 8)} died (${reason}) — ` +
          `retry ${this.resumeRetryAttempts}/${RESUME_RETRY_BACKOFF_MS.length} in ${Math.round(delay / 1000)}s`,
      );
      this.resumeRetryTimer = setTimeout(() => {
        this.resumeRetryTimer = null;
        this.resumePersistedSession();
      }, delay);
      this.resumeRetryTimer.unref?.();
      return;
    }
    // Retries exhausted — fail LOUDLY and visibly, then keep the slow
    // heartbeat re-probe alive (resumeRecoveryTick) instead of giving up.
    this.resumeExhausted = true;
    this.lastResumeReprobeAt = Date.now();
    log.error(
      'host-agent',
      `resumed session ${session.id.slice(0, 8)} FAILED permanently after ` +
        `${RESUME_RETRY_BACKOFF_MS.length + 1} attempts (${reason}) — ` +
        `posting visible error, re-probing every ${Math.round(RESUME_REPROBE_INTERVAL_MS / 60_000)} min`,
    );
    if (!this.resumeFailurePosted) {
      this.resumeFailurePosted = true;
      if (session.pluginId && session.pluginAuthToken) {
        void this.postResumeFailure(
          {
            sessionId: session.id,
            pluginId: session.pluginId,
            pluginAuthToken: session.pluginAuthToken,
          },
          `The agent failed to restart after a CLI update/restart (${reason}). ` +
            `I tried ${RESUME_RETRY_BACKOFF_MS.length + 1} times without success. ` +
            `The host stays online and keeps retrying about every ` +
            `${Math.round(RESUME_REPROBE_INTERVAL_MS / 60_000)} minutes — once the cause is fixed ` +
            `(for example the agent binary is reinstalled), the session reconnects automatically. ` +
            `You can also redeploy this server from My Servers.`,
        ).catch(() => undefined);
      } else {
        log.warn(
          'host-agent',
          'resume failure bubble skipped — persisted session has no pluginAuthToken',
        );
      }
    }
  }

  /**
   * Heartbeat rider for resume recovery (synchronous scheduling only — the
   * beat must stay punctual, and this adds NO new timers):
   *   - a live session child ⇒ the failure episode (if any) is over: reset
   *     the retry counter + flags so a FUTURE restart gets fresh retries and
   *     a fresh (single) error bubble.
   *   - retries exhausted + no child ⇒ re-probe the resume, throttled to
   *     {@link RESUME_REPROBE_INTERVAL_MS}, so a fixed PATH / reinstalled
   *     binary heals the session WITHOUT another manual restart. A re-probe
   *     that fails again stays in this state (the bubble is not re-posted).
   */
  private resumeRecoveryTick(): void {
    if (this.children.size > 0) {
      // Reset only once a child has PROVEN healthy (age gate) — a child that
      // merely survived one heartbeat tick must not refill the retry budget,
      // or a slow crash-loop would retry silently forever and never reach
      // the visible-error path.
      const now = Date.now();
      const hasHealthyChild = [...this.children.values()].some(
        (c) => now - c.startedAt >= RESUME_HEALTHY_AFTER_MS,
      );
      if (hasHealthyChild && (this.resumeRetryAttempts > 0 || this.resumeExhausted)) {
        log.info('host-agent', 'resume recovered — session child healthy, retry state reset');
        this.resumeRetryAttempts = 0;
        this.resumeExhausted = false;
        this.resumeFailurePosted = false;
      }
      return;
    }
    if (!this.resumeExhausted || this.resumeRetryTimer) return;
    const now = Date.now();
    if (now - this.lastResumeReprobeAt < RESUME_REPROBE_INTERVAL_MS) return;
    this.lastResumeReprobeAt = now;
    log.info('host-agent', 'resume re-probe (post-exhaustion heartbeat rider)');
    this.resumePersistedSession();
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
  private async runAgentInstall(script: string): Promise<void> {
    // Delegates to the shared runner (also used by the in-session
    // `switch_agent` flow). Best-effort here by design — a failed install
    // only degrades `claude -p` / `codex` preview detection.
    const res = await runAgentInstallScript(script, { logScope: 'host-agent' });
    if (!res.ok) {
      log.warn(
        'host-agent',
        'agent install failed — preview detection may be unavailable; agent still runs',
      );
    }
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
   * Handle `self_hosted_cleanup { deployId }` — the app deleted this deploy's
   * session. Remove its on-disk workspace so a persistent box doesn't accumulate
   * one dir per deleted session. Stops any still-running child for the deploy
   * first (the delete also pushes `session_terminated` to the child, but this is
   * race-safe), then removes the two `~/.codeam/...<deployId>` dirs.
   *
   * Idempotent (`force: true` → no throw if already gone) and inherently safe:
   * the dir is keyed by the UNIQUE `deployId`, so it can never be another live
   * session's workspace, and these paths only ever exist for a cloned
   * self-hosted deploy (a local / absolute-path target has no such dir → no-op).
   */
  private cleanupWorkspace(deployId: string): void {
    const short = deployId.slice(0, 8);
    // Stop the child if it's somehow still tracked (its own session_terminated
    // usually already exited it) so nothing holds the dir open mid-remove.
    const child = this.children.get(deployId);
    if (child) {
      try {
        child.proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      this.children.delete(deployId);
    }
    const dirs = [
      path.join(selfHostedWorkspaceRoot(), deployId),
      path.join(os.homedir(), '.codeam', 'house-claude', deployId),
    ];
    for (const dir of dirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        log.warn(
          'host-agent',
          `cleanup: failed to remove ${dir}: ${(err as Error).message}`,
        );
      }
    }
    log.info('host-agent', `cleaned up workspace for deleted deploy=${short}`);
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
 *     but was already consumed) → redeem fails TERMINALLY (the backend has
 *     no way to distinguish "replayed token" from "genuinely bad token" —
 *     both come back as the same `ENROLL_TOKEN_EXPIRED`/`INVALID` 4xx) → we
 *     fall back to the sealed identity and carry on, REGARDLESS of whether
 *     the box is a normal self-hosted install or an ephemeral/fleet one.
 *     `Restart=always` bakes the token in permanently, so this is the common
 *     case on every restart after the first successful enroll — treating it
 *     as fatal is what turned a single dead token into an infinite
 *     restart-crash loop (P0, 2026-07). If the sealed identity itself turns
 *     out to be dead too (the host was actually deleted server-side), the
 *     very next heartbeat gets a genuine auth-rejection and
 *     `onIdentityRejected` self-heals from there — so resuming here is
 *     always safe to attempt.
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
        // A terminal 4xx here almost always means "this token was already
        // consumed" (a plain restart replaying the same baked-in env var —
        // the systemd unit's `Restart=always` never strips it after first
        // enroll), not "the user just typed a bad token". The backend
        // response is IDENTICAL either way, so the only safe signal we have
        // is: do we already hold a sealed identity from a prior successful
        // enroll? If so, RESUME from it instead of dying — this applies to
        // every self-hosted box, not just fleet/ephemeral ones (fleet boxes
        // hit this on literally every restart since their token is a fixed
        // container env var, but a plain self-hosted box hits the exact
        // same failure mode on its second boot after enroll). If that sealed
        // identity turns out to be genuinely dead (the host was deleted
        // server-side), the very next heartbeat gets a real auth-rejection
        // and `onIdentityRejected` wipes it + disables the service —
        // self-correcting, so resuming here can never wedge the box.
        if (existing) {
          log.info(
            'host-agent',
            'enroll token terminally rejected (expired/replayed) but a sealed identity is ' +
              'present; resuming from it — likely a restart, not a re-enroll',
          );
          return existing;
        }
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
  // Daemon crash guard: `hostAgent()` is the ONE long-lived entry point that
  // didn't install this (unlike `pairAuto`/`start`/`startInfraOnly`), so a
  // stray unhandled rejection inside the supervisor (a fire-and-forget
  // heartbeat/progress POST, background provisioning, etc.) surfaced as a
  // bare uncaught exception — silent process death, immediately restarted
  // by systemd into the same failure (part of the P0 crash-loop). Idempotent.
  installRelayCrashGuards();

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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID, randomBytes, createHash } from 'crypto';
import { resolveApiBaseUrl, isKnownAgentId } from '@codeam/shared';
import { addSession, loadCliConfig, type SavedSession } from '../config';
import { capture, identifyUser } from '../services/telemetry.service';
import { vercelBypassHeader } from '../lib/backend-headers';
import { rmIfExistsQuiet } from '../lib/quiet';
import { detectCurrentBranch } from '../lib/git-branch';
import { start } from './start';
import { startInfraOnly } from './start-infra-only';
import { maybeStartHeadroomReporter } from './host-agent';
import { installRelayCrashGuards } from '../lib/process-guards';

/**
 * `codeam pair-auto` — non-interactive pair, used INSIDE a freshly-
 * provisioned GitHub Codespace. The backend's `/api/deploys/codespace`
 * SSE handler has already minted a one-shot auto-pair token and
 * shipped it into the codespace via SSH env. The bootstrap script
 * writes the token to a 0600 temp file and invokes us with
 * `--token-file=<path>` (we never accept the token on argv to keep
 * it out of `ps -ef`).
 *
 * Once the redemption succeeds, this drops a SavedSession into the
 * config + chains into `start()` so the daemon polls commands the
 * same way `codeam pair` does.
 */

interface ClaimSuccess {
  sessionId: string;
  pluginAuthToken?: string;
  agent: string;
  user: { name: string; email: string; plan: string };
}

interface ClaimErrorBody {
  success: false;
  error: { code: string; message: string };
}

const API_BASE = resolveApiBaseUrl();

function fail(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

function resolveTokenValue(args: string[]): string {
  const inline = args.find((a) => a.startsWith('--token='));
  if (inline) {
    const value = inline.slice('--token='.length).trim();
    if (value.length > 0) return value;
  }
  const fileFlag = args.find((a) => a.startsWith('--token-file='));
  if (fileFlag) {
    const path = fileFlag.slice('--token-file='.length);
    try {
      const content = fs.readFileSync(path, 'utf8').trim();
      if (content.length === 0) fail(`--token-file ${path} is empty`);
      // The bootstrap script created this file 0600. It deletes it on
      // shell EXIT, but we delete proactively too — the token is
      // single-use and we don't want it lingering on disk if `start()`
      // crashes before the EXIT trap fires.
      rmIfExistsQuiet(path);
      return content;
    } catch (err) {
      fail(`Could not read --token-file: ${(err as Error).message}`);
    }
  }
  if (process.env.CODEAM_AUTO_TOKEN) return process.env.CODEAM_AUTO_TOKEN;
  fail('codeam pair-auto requires --token-file=<path>, --token=<value>, or CODEAM_AUTO_TOKEN env');
}

/**
 * Resolve the pair-auto token AND publish the auto/headless-plane marker.
 *
 * `pair-auto` is the AUTOMATED, headless daemon (codespace bootstrap /
 * self-hosted host-agent) — never an interactive local session. Resolving its
 * token is the exact moment we KNOW this is the auto plane, so we set
 * `CODEAM_AUTO_TOKEN` here. That trips `isLocalSession()` (baton/gate.ts) to
 * FALSE so the session-baton never engages the interactive native TUI in a
 * headless daemon — INDEPENDENT of whether the caller set `CODESPACES` /
 * `CODEAM_AUTO_APPROVE`. Without this, a `pair-auto --token-file=…` launched
 * with no other env markers wrongly took the baton branch (native TUI) instead
 * of `runAcpSession`, so the synthesized `agent_banner` chunk never reached the
 * app. In prod, codespaces set `CODESPACES=true` and host-agent sets this same
 * var, so this only tightens a latent gap; real local `codeam pair` (which
 * never runs pair-auto) is untouched and keeps the baton.
 *
 * Exported so the invariant "pair-auto is never a local/baton session" is
 * unit-tested without the network claim in {@link pairAuto}.
 */
export function readTokenFromArgs(args: string[]): string {
  const token = resolveTokenValue(args);
  process.env.CODEAM_AUTO_TOKEN = token;
  return token;
}

/**
 * Single attempt at the claim POST. Wrapped with AbortController so a
 * stalled backend doesn't hang the codespace bootstrap until the SSH
 * channel hits its 180 s timeout — bootstrap-side scripts get a clear
 * NETWORK error within {@link CLAIM_TIMEOUT_MS} instead.
 */
const CLAIM_TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = 2_000;

interface NetworkError extends Error {
  code: 'NETWORK';
  cause?: unknown;
}

function networkError(msg: string, cause?: unknown): NetworkError {
  const err = new Error(msg) as NetworkError;
  err.code = 'NETWORK';
  if (cause !== undefined) err.cause = cause;
  return err;
}

async function claimOnce(
  token: string,
  pluginId: string,
  pluginSecretHash?: string,
): Promise<ClaimSuccess> {
  const url = `${API_BASE}/api/pairing/claim-auto-token`;
  const body = {
    token,
    pluginId,
    ideName: 'codeam-cli (codespace)',
    ideVersion: process.env.npm_package_version ?? 'unknown',
    hostname: os.hostname(),
    codespaceName: process.env.CODESPACE_NAME ?? '',
    // Current git branch of the codespace's working directory, so the
    // backend can populate `PairedSession.branch` for the codespace pair.
    // `null` when detached HEAD / not a git repo.
    branch: detectCurrentBranch(),
    // SEC crit1 (#813): enroll the PoP hash so /status + /reconnect for
    // this codespace session require the raw secret. Older backends
    // ignore the unknown field.
    ...(pluginSecretHash ? { pluginSecretHash } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAIM_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...vercelBypassHeader() },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // AbortError, DNS failure, ECONNREFUSED — all surface as
    // NETWORK so the outer retry loop knows to back off + retry,
    // and the bootstrap shell can pattern-match on the code.
    const aborted = (err as { name?: string }).name === 'AbortError';
    throw networkError(
      aborted ? `request timed out after ${CLAIM_TIMEOUT_MS}ms` : `fetch failed: ${(err as Error).message}`,
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  // 5xx is transient — let the retry loop catch it via NETWORK code.
  if (res.status >= 500 && res.status < 600) {
    throw networkError(`server returned ${res.status}`);
  }

  const json = (await res.json()) as { success: boolean; data?: ClaimSuccess } | ClaimErrorBody;

  if (!res.ok || !('success' in json) || !json.success) {
    const errBody = json as ClaimErrorBody;
    const code = errBody?.error?.code ?? `HTTP_${res.status}`;
    const msg = errBody?.error?.message ?? `Server returned ${res.status}`;
    // 4xx is deterministic — fail loud immediately instead of retrying.
    fail(`Auto-pair failed (${code}): ${msg}`);
  }

  const ok = json as { success: true; data: ClaimSuccess };
  if (!ok.data?.sessionId) {
    fail('Auto-pair response missing sessionId');
  }
  return ok.data;
}

async function claim(
  token: string,
  pluginId: string,
  pluginSecretHash?: string,
): Promise<ClaimSuccess> {
  try {
    return await claimOnce(token, pluginId, pluginSecretHash);
  } catch (err) {
    if ((err as NetworkError).code !== 'NETWORK') throw err;
    // One retry after a short backoff. The codespace bootstrap is the
    // primary caller; a single retry covers the common case where
    // the API container is still cold-starting when the bootstrap
    // first reaches it. Two attempts is enough — beyond that the
    // bootstrap shell should re-invoke us.
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    try {
      return await claimOnce(token, pluginId, pluginSecretHash);
    } catch (retryErr) {
      const netErr = retryErr as NetworkError;
      fail(`Auto-pair failed (NETWORK): ${netErr.message}`);
    }
  }
}

/** Resolved per-call so tests can redirect via HOME/USERPROFILE. */
function pairAutoLockPath(): string {
  return path.join(os.homedir(), '.codeam', 'pair-auto.lock');
}

/** True only if `pid` is a LIVE `codeam` process (guards against PID reuse). */
export function isLivePairAuto(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0); // throws ESRCH if gone; EPERM means alive-but-not-ours
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  // On Linux (codespaces) confirm it's actually a codeam process so a reused
  // PID doesn't make us defer to an unrelated process. No /proc → trust the
  // liveness check (macOS local pairs).
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('codeam');
  } catch {
    return true;
  }
}

/**
 * Same liveness check as `isLivePairAuto` but not restricted to pair-auto —
 * any `codeam` process (bare `codeam`, `codeam start`, `codeam pair-auto`…)
 * satisfies this. Used by the daemon singleton guard where the lock holder is
 * typically the bare `codeam` / `start` daemon, not specifically pair-auto.
 *
 * Platform handling is identical to `isLivePairAuto`: Linux uses /proc cmdline
 * to guard against PID reuse; macOS / Windows fall back to signal-0 liveness.
 */
export function isLiveCodeam(pid: number): boolean {
  return isLivePairAuto(pid);
}

/** Lock-file path for the per-session daemon singleton. Resolved per-call so
 *  tests can redirect via HOME/USERPROFILE. sessionId is sanitised so it is
 *  safe to embed in a filename on every OS. */
export function daemonLockPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.homedir(), '.codeam', `daemon-${safe}.lock`);
}

/**
 * Acquire the per-session daemon singleton. Returns true if THIS process now
 * owns the daemon slot for `sessionId`, false if another LIVE codeam process
 * already holds it.
 *
 * Fail-open: any lock-infra error returns true (never block a daemon from
 * starting). PID-based with a liveness check so a stale lock from a crashed
 * daemon is automatically reclaimed on the next launch. Signal handlers
 * release the lock on clean exit; the `process.once('exit')` guard covers
 * hard-exit paths.
 *
 * Self-hosted / local pairs spawn distinct sessionIds → distinct lock files;
 * no codespace-specific assumptions are made here.
 */
export function acquireDaemonLock(sessionId: string): boolean {
  const lockPath = daemonLockPath(sessionId);
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = Number(fs.readFileSync(lockPath, 'utf8').trim());
      if (holder && holder !== process.pid && isLiveCodeam(holder)) return false;
      // Stale lock (crashed daemon) or re-acquire by the same process — reclaim.
      fs.writeFileSync(lockPath, String(process.pid));
    }
    const release = () => {
      try {
        if (
          fs.existsSync(lockPath) &&
          Number(fs.readFileSync(lockPath, 'utf8').trim()) === process.pid
        ) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        /* best-effort */
      }
    };
    process.once('exit', release);
    process.once('SIGTERM', () => { release(); process.exit(0); });
    process.once('SIGINT', () => { release(); process.exit(0); });
    return true;
  } catch {
    return true; // fail-open — never block a daemon from starting
  }
}

/**
 * Singleton guard — at most ONE `codeam pair-auto` per machine/codespace.
 *
 * The backend bootstrap can fire twice (deploy + a wake, or a retry), each
 * launching its own `pair-auto`. Two daemons paired to the same session both
 * poll `/commands/pending` and heartbeat, so the mobile's commands + events
 * get split between them and stall (e.g. Start Preview hangs on "Detecting
 * project…" forever — the `request_preview_detect` lands on one process while
 * the reply is expected from the other). This guard makes a second launch
 * detect the live owner and defer to it instead of split-braining the session.
 *
 * Exclusive-create (`wx`) wins the race atomically; a stale lock (crashed
 * prior run) is reclaimed. Fail-open: lock-infra errors never block pairing.
 * Returns false when another live pair-auto already owns the session.
 */
export function acquireSingletonLock(): boolean {
  const lockPath = pairAutoLockPath();
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = Number(fs.readFileSync(lockPath, 'utf8').trim());
      if (isLivePairAuto(holder)) return false; // another pair-auto owns it
      fs.writeFileSync(lockPath, String(process.pid)); // reclaim stale lock
    }
    process.once('exit', () => {
      try {
        if (
          fs.existsSync(lockPath) &&
          Number(fs.readFileSync(lockPath, 'utf8').trim()) === process.pid
        ) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        /* best-effort cleanup */
      }
    });
    return true;
  } catch {
    return true; // never block pairing on a lock-infra failure
  }
}

export async function pairAuto(args: string[]): Promise<void> {
  // Daemon crash guard: a stray unhandled rejection must never take down the
  // self-hosted/codespace relay (no supervisor relaunches it). Idempotent —
  // start()/startInfraOnly() call it again once we dispatch into them.
  installRelayCrashGuards();
  // One pair-auto per codespace — a duplicate launch would split-brain the
  // session (see acquireSingletonLock). Defer to the running owner.
  //
  // ⚠️ EXCEPT under a multi-session host-agent supervisor (self-hosted / fleet /
  // warm codespace): it spawns ONE pair-auto child PER deploy, each a DISTINCT
  // session, so the box-wide singleton is exactly wrong there — it made the 2nd+
  // concurrent deploy defer + exit(0) before it could even claim, so only ONE
  // session ever survived per box (the warm-codespace multi-session bug). The
  // supervisor marks its children with `CODEAM_HOST_AGENT_CHILD=1`; they skip the
  // singleton entirely. Each is still protected against a DUPLICATE of its OWN
  // session by the per-session `acquireDaemonLock(session.id)` in start().
  if (process.env.CODEAM_HOST_AGENT_CHILD !== '1' && !acquireSingletonLock()) {
    capture('pair_auto_deferred_singleton', {});
    // eslint-disable-next-line no-console
    console.log('  A codeam session is already running here — deferring to it.');
    return;
  }
  const token = readTokenFromArgs(args);
  const pluginId = randomUUID();
  // SEC crit1 (#813): same PoP secret as the interactive pair flow, so
  // the codespace session is gated on /status + /reconnect too.
  const pollSecret = randomBytes(32).toString('base64url');
  const pluginSecretHash = createHash('sha256').update(pollSecret).digest('hex');
  capture('pair_auto_started', { pluginId });

  // eslint-disable-next-line no-console
  console.log('  Claiming pairing token…');
  const claimed = await claim(token, pluginId, pluginSecretHash);

  // Validate the agent the API picked is one this CLI version knows about.
  // (Forward-compat guard for when the backend ships an agent we haven't released yet.)
  if (!isKnownAgentId(claimed.agent)) {
    fail(
      `agent "${claimed.agent}" is not supported in this codeam-cli version. ` +
      `Upgrade with 'npm i -g codeam-cli@latest'.`,
    );
  }

  // Build THIS deploy's session once so we can both persist it AND pin start()
  // to it. ⚠️ Multi-session (warm codespace): the host-agent spawns one
  // pair-auto child per deploy, and `addSession` clobbers the single shared
  // "active" pointer — so we must hand start() this exact session rather than
  // let it re-read `getActiveSession()` (which every concurrent child would
  // resolve to the SAME newest one → daemon-lock collision → all but one exit).
  const claimedSession: SavedSession = {
    id: claimed.sessionId,
    pluginId,
    userName: claimed.user.name,
    userEmail: claimed.user.email,
    plan: claimed.user.plan,
    pairedAt: Date.now(),
    pluginAuthToken: claimed.pluginAuthToken,
    // SEC crit1 (#813): persist so boot-time /reconnect proves possession.
    pollSecret,
    agent: claimed.agent,
  };
  addSession(claimedSession);

  identifyUser({
    userId: claimed.user.email,
    email: claimed.user.email,
    name: claimed.user.name,
    plan: claimed.user.plan,
    preferredAgent: claimed.agent,
    pairedSessionCount: loadCliConfig().sessions.length,
  });
  capture('pair_auto_succeeded', {
    sessionId: claimed.sessionId,
    pluginId,
    agentId: claimed.agent,
    codespaceName: process.env.CODESPACE_NAME ?? undefined,
  });

  // eslint-disable-next-line no-console
  console.log(`  Paired with ${claimed.user.name} (${claimed.user.plan})`);

  // Auto-login OFF deploy: the bootstrap shell exported
  // CODEAM_SKIP_AGENT_LAUNCH=true so we pair the session and run
  // the infra-only loop — same wiring as `start()` (heartbeat +
  // file watcher + IDE terminal handlers + IDE-safe command
  // dispatch) MINUS the agent spawn. The dashboard's Files /
  // terminal / git surfaces all work; only chat-style
  // `start_task` / `provide_input` / etc. are dropped (no agent
  // to forward them to). The relay reports an EMPTY agents list
  // so the dashboard detects `sessionVariant === 'no-agent'` and
  // renders the NoAgentHero install CTA.
  //
  // The user later installs an agent via the hero — that flow
  // SSHes back in and launches `codeam` from a fresh login shell
  // that doesn't inherit `CODEAM_SKIP_AGENT_LAUNCH`, so `start()`
  // takes over there with the full agent loop.
  // NOTE: auto-provisioning project deps was previously kicked off here
  // fire-and-forget, but running a heavy `docker compose up -d --wait`
  // (cold image pull of Postgres etc.) CONCURRENTLY with the live agent
  // session starved/OOM-killed the codeam CLI + ACP agent on small
  // codespaces — the relay dropped, the agent froze, the plugin went
  // offline (v2.39.0 regression). Provisioning must run at codespace
  // CREATION (devcontainer postCreate), before the agent session is live,
  // and with resource limits — NOT in-session. Disabled until re-engineered.
  // The `provisionProjectDependencies` module is retained for that work.

  if (process.env.CODEAM_SKIP_AGENT_LAUNCH === 'true') {
    capture('pair_auto_skipped_launch', {
      sessionId: claimed.sessionId,
      pluginId,
      agentId: claimed.agent,
      codespaceName: process.env.CODESPACE_NAME ?? undefined,
    });
    // eslint-disable-next-line no-console
    console.log(
      '  Skipping agent launch — install an agent from the dashboard to start chatting.',
    );
    await startInfraOnly(claimed.agent);
    return;
  }

  // eslint-disable-next-line no-console
  console.log('  Starting agent loop…');

  // Best-effort Headroom savings reporter — enabled only when
  // HEADROOM_ENABLED=1 (injected by the backend for PRO users). A missing
  // or misbehaving Headroom proxy never blocks the agent from starting.
  // Skip entirely when pluginAuthToken is absent/empty: an empty token
  // guarantees a 401 on every savings POST (metering lost, 401-storm).
  const headroomReporter = claimed.pluginAuthToken
    ? maybeStartHeadroomReporter({
        sessionId: claimed.sessionId,
        pluginId,
        pluginAuthToken: claimed.pluginAuthToken,
        codespaceId: process.env['CODESPACE_NAME'] ?? claimed.sessionId,
      })
    : null;
  process.once('exit', () => { headroomReporter?.stop(); });

  // Hand off to the same long-running poller `codeam pair` ends with — PINNED to
  // this deploy's own session so concurrent host-agent children don't collide on
  // the shared active-session pointer / daemon lock (multi-session, warm codespace).
  await start(undefined, claimedSession);
}

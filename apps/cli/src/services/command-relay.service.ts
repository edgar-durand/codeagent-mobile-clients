import * as https from 'https';
import * as http from 'http';
import { resolveApiBaseUrl } from '@codeam/shared';
import type { AgentMetadata } from '@codeam/shared';
import { _postJson, _getJson } from './pairing.service';
import { loadCliConfig } from '../config';
import { vercelBypassHeader } from '../lib/backend-headers';
import { computePollDelay } from '../lib/poll-delay';
import { detectCurrentBranch, detectCurrentBranchAsync } from '../lib/git-branch';
import { log } from './logger';
import {
  ensureHeadroomProxy,
  makeRealProxySupervisorDeps,
  type ProxySupervisorDeps,
} from './headroom/proxy-supervisor';

/** tsup-injected build constant (see index.ts); absent in ts-node/tests. */
declare const __CLI_VERSION__: string;

/** Narrow an unknown thrown value to its numeric HTTP status, when the
 *  transport attached one (pairing.service errors carry `statusCode`). */
function httpStatusOf(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const status = (err as { statusCode: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return null;
}
import { capture } from './telemetry.service';

const API_BASE = resolveApiBaseUrl();
// Server emits a `ping` SSE event every 30 s — give it 15 s of grace
// before declaring the connection zombie. Probes every 10 s so the
// max detection latency is ~55 s.
const SSE_LIVENESS_TIMEOUT_MS = 45_000;
const SSE_WATCHDOG_INTERVAL_MS = 10_000;

export interface RemoteCommand {
  id: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Bidirectional command relay. The modern path is an SSE pull
 * stream that the backend pushes commands down — backend wakes the
 * CLI within ~50 ms of `pushCommand` instead of waiting on a 0-2 s
 * polling tick. Vercel's 25 s function-invocation cap closes the
 * stream periodically; the CLI immediately reconnects (long-poll
 * style).
 *
 * If the SSE endpoint is unreachable for any reason (network hiccup,
 * older backend without `/pending/stream`, proxy that strips SSE)
 * the relay falls back to plain HTTP polling. Both modes share the
 * same `onCommand` dispatch.
 */
export class CommandRelayService {
  private _running = false;
  private pairingInvalid = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private agentsTimer: NodeJS.Timeout | null = null;
  private headroomSupervisorTimer: NodeJS.Timeout | null = null;
  /** Injectable for tests; defaults to real fs/fetch/spawn wiring. */
  private headroomSupervisorDeps: ProxySupervisorDeps = makeRealProxySupervisorDeps();
  /** True once `/api/plugin/agents` has accepted at least one report. */
  private agentsRegistered = false;
  /** SSE connection (null when on the polling fallback or stopped). */
  private sseRequest: http.ClientRequest | null = null;
  // At-least-once delivery: the backend now delivers commands NON-DESTRUCTIVELY
  // (peek) when we advertise `X-Codeam-Cmd-Ack: 1`, and drains the queue only
  // when we ack the ids. So a command can never be lost to a ghost/racing SSE
  // subscriber during codespace boot (the 2026-07-15 first-prompt loss). The
  // trade-off is possible REDELIVERY (reconnect, publish re-fire, ghost race),
  // so we dedupe by id here — a bounded FIFO set of ids we've already
  // dispatched. Cap keeps memory flat over a long session; the oldest ids are
  // evicted (a command that old is long gone from the server queue anyway).
  private readonly processedIds = new Set<string>();
  private static readonly PROCESSED_ID_CAP = 1000;
  /** After the first, re-warn every Nth consecutive ack failure — loud enough
   *  to notice, quiet enough not to drown the log during a network outage. */
  private static readonly ACK_WARN_EVERY = 20;

  /** Polling backoff state (only used on the fallback). */
  private pollTimer: NodeJS.Timeout | null = null;
  private pollFailures = 0;
  /** Consecutive ack POST failures — drives the visibility escalation below. */
  private ackFailures = 0;
  // Successive polls that returned no commands. Drives an idle
  // backoff so a CLI sitting on the polling fallback (SSE was
  // unavailable) doesn't keep hammering the API every 2 s when
  // there's nothing to do. Reset to 0 whenever a poll DELIVERS a
  // command, so the first real work after a quiet period still
  // reaches the CLI quickly.
  private pollEmptyStreak = 0;
  /** Reconnect backoff state for the SSE stream. */
  private sseFailures = 0;
  private sseReconnectTimer: NodeJS.Timeout | null = null;
  /**
   * Liveness watchdog for the SSE socket. The server pings every 30 s
   * (`pending-stream.controller.ts` interval(30_000)). If we go more
   * than `SSE_LIVENESS_TIMEOUT_MS` without ANY bytes, we assume the
   * TCP peer died half-open (Cloud Run scaled / redeployed mid-stream,
   * NAT dropped the conntrack entry, laptop slept) and force a
   * reconnect. Without this the kernel can keep the socket in a
   * zombie ESTABLISHED state for HOURS before the default TCP
   * keepalive triggers — observed live in #190 where a 17:18 redeploy
   * left CLIs subscribed for >30 minutes without ever receiving a
   * pushed command.
   */
  private sseWatchdog: NodeJS.Timeout | null = null;
  private sseLastByteAt = 0;
  /**
   * Last-known git branch, shipped on every heartbeat. Seeded with a
   * single SYNCHRONOUS read at `start()` (before any turn is running)
   * for an accurate first beat, then refreshed ASYNCHRONOUSLY off the
   * recurring heartbeat tick. The heartbeat POST reads this cached
   * value and never spawns `git` synchronously — so the 20 s beat
   * stays punctual even while a long agent tool call is hammering the
   * event loop. Trade-off: because the async refresh fires alongside
   * the POST (not before it), a `git checkout` propagates on the NEXT
   * beat — up to ~40 s worst case vs the old at-POST-time read. The
   * backend dedupes a stable branch, so this lag costs nothing but
   * freshness, and a punctual heartbeat matters far more.
   */
  private cachedBranch: string | null = null;

  constructor(
    private readonly pluginId: string,
    private readonly onCommand: (cmd: RemoteCommand) => void | Promise<void>,
    /**
     * Metadata of the agent this CLI is hosting. Reported to
     * `/api/plugin/agents` so the mobile and web headers can render
     * the correct name + icon for the session.
     *
     * Required as of #56 — the historical Claude fallback was dead
     * code (start.ts has always passed an explicit meta since #50)
     * and it silently mis-labelled non-Claude sessions when tests
     * forgot to pass one.
     *
     * Mutable (not `readonly`) since the in-session agent switch:
     * `switch_agent` swaps the running agent on the SAME relay instance
     * (keeping SSE + the pending command's ack path alive) and calls
     * {@link setAgentMeta} + {@link reannounceAgents} to re-register.
     */
    private agentMeta: AgentMetadata,
    /**
     * When set, `reportAgents` posts THIS list to
     * `/api/plugin/agents` instead of the single-entry default
     * derived from `agentMeta`. Used by the infra-only / no-agent
     * codespace path (`codeam pair-auto` with
     * `CODEAM_SKIP_AGENT_LAUNCH=true`): the CLI is alive +
     * heartbeating so the session card shows online and the
     * dashboard's `SessionPage` exits its "Loading session…"
     * gate, but no agent process is running so the agents list
     * MUST be empty — otherwise the dashboard renders a chat
     * surface for an agent that isn't actually there and the
     * user can't reach the NoAgentHero install CTA.
     */
    private readonly agentsOverride?: ReadonlyArray<{
      id: string;
      name: string;
      icon: string;
      installed: boolean;
    }>,
    /**
     * Explicit proof-of-possession poll secret for THIS relay's plugin.
     *
     * Session relays leave this undefined and let `pollSecretHeader` resolve
     * the secret from the persisted session (keyed by `pluginId`). The
     * host-agent's CONTROL channel has no session row — its plugin is not a
     * session — so it passes the secret directly (persisted in the sealed host
     * identity as `controlPollSecret`). When set, it takes precedence over the
     * config lookup and is replayed as `X-Plugin-Poll-Secret`.
     */
    private readonly explicitPollSecret?: string,
    /**
     * Optional rider on the recurring heartbeat tick — invoked from the SAME
     * 20 s `setInterval` that sends the heartbeat, right after the beat is
     * issued. Exists so a feature that must periodically RE-ASSERT something
     * to the backend (today: the session baton re-affirming its driver state
     * so the backend's 1 h Redis snapshot never expires under a live session)
     * can ride the sanctioned tick instead of adding a second polling timer
     * — see CLAUDE.md "No polling for realtime".
     *
     * ⚠️ Same contract as the beat itself (CLAUDE.md "Heartbeat must stay
     * punctual"): the rider MUST do zero synchronous I/O and return
     * immediately — anything it needs to send is fire-and-forget. It is
     * called inside a try/catch so a throwing rider can never kill the beat.
     *
     * `firstAfterConnect` is true on the beat issued by `start()` and on the
     * first beat after the relay establishes its command channel (a fresh SSE
     * connection or a switch to the polling fallback), so a rider can
     * re-assert immediately after a reconnect instead of waiting out its own
     * throttle window.
     */
    private readonly onHeartbeat?: (info: { firstAfterConnect: boolean }) => void,
  ) {}

  /**
   * Set whenever the command channel is (re-)established; consumed by the
   * next {@link emitHeartbeatTick}. See the `onHeartbeat` ctor param.
   */
  private heartbeatFirstAfterConnect = true;

  /** Invoke the heartbeat rider (if any) exactly once per beat. Never throws. */
  private emitHeartbeatTick(): void {
    if (!this.onHeartbeat) return;
    const firstAfterConnect = this.heartbeatFirstAfterConnect;
    this.heartbeatFirstAfterConnect = false;
    try {
      this.onHeartbeat({ firstAfterConnect });
    } catch (err) {
      log.trace('relay', 'heartbeat rider threw (ignored)', err);
    }
  }

  start(): void {
    this.cleanup();

    this._running = true;
    this.heartbeatFirstAfterConnect = true;
    this.agentsRegistered = false;
    log.info('relay', `start pluginId=${this.pluginId.slice(0, 8)} agent=${this.agentMeta.id}`);
    // Seed the branch synchronously ONCE here — `start()` runs before
    // any agent turn, so the one-time blocking read is harmless and
    // gives the first heartbeat an accurate branch. Every subsequent
    // refresh is async (see `refreshBranch`), keeping the recurring
    // beat off the synchronous-git path.
    this.cachedBranch = detectCurrentBranch();
    this.sendHeartbeat(true);
    this.emitHeartbeatTick();
    this.heartbeatTimer = setInterval(() => {
      // Refresh the branch off the hot path, then beat with the cached
      // value. The async refresh can never delay this tick's POST.
      void this.refreshBranch();
      this.sendHeartbeat(true);
      // Riders run AFTER the beat is issued so they can never delay it.
      this.emitHeartbeatTick();
    }, 20_000);
    this.agentsTimer = setInterval(() => {
      if (this._running && !this.agentsRegistered) this.reportAgents();
    }, 5_000);
    this.reportAgents();

    // Keep the Headroom proxy (:8787) alive for the session. The agent is
    // wired to ANTHROPIC_BASE_URL=127.0.0.1:8787; if the proxy dies while
    // the box stays up (codespace resume, crash), every turn hangs 90s. A
    // no-op on non-Headroom boxes. Fire-and-forget so it never delays the
    // beat; the check itself is async + off the hot path.
    void ensureHeadroomProxy(this.headroomSupervisorDeps).catch(() => undefined);
    this.headroomSupervisorTimer = setInterval(() => {
      void ensureHeadroomProxy(this.headroomSupervisorDeps).catch(() => undefined);
    }, 30_000);

    // Try SSE pull first. If the connection fails twice in a row we
    // assume the endpoint isn't available and switch to polling.
    //
    // Vitest sets NODE_ENV=test, in which case we skip SSE outright
    // (real HTTPS would hit production). Tests cover the polling
    // path directly and a separate suite covers the SSE consumer.
    if (process.env.NODE_ENV === 'test' || process.env.CODEAM_DISABLE_SSE_PULL === '1') {
      log.info('relay', 'SSE disabled — using polling fallback');
      this.startPollingFallback();
    } else {
      this.connectSSE();
    }
  }

  /**
   * Stop the relay. Kept SYNCHRONOUS for the many callers that just tear down
   * — the goodbye heartbeat is fired but NOT awaited here.
   *
   * ⚠️ On a shutdown path that calls `process.exit()` right after, use
   * {@link stopAndFlush} (or {@link stopRelayWithGoodbye}) instead: the process
   * dies before the fire-and-forget POST hits the wire, so the backend never
   * learns the CLI went away and mobile keeps showing the session ONLINE until
   * the 30 s Redis heartbeat key expires — silently, since nothing publishes on
   * expiry (the 2026-08-18 "closing Claude Code leaves mobile online" report).
   */
  stop(): void {
    void this.stopAndFlush();
  }

  /**
   * Same teardown as {@link stop}, but resolves only once the `online:false`
   * heartbeat POST has settled — so a caller can `await` it before exiting.
   * Never rejects (`sendHeartbeat` swallows its own transport errors).
   */
  async stopAndFlush(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    this.cleanup();
    await this.sendHeartbeat(false);
  }

  async sendResult(
    commandId: string,
    status: string,
    result: unknown,
  ): Promise<void> {
    // Latched after an unrecoverable auth failure — see below.
    if (this.pairingInvalid) return;
    try {
      await _postJson(`${API_BASE}/api/commands/result`, { commandId, status, result });
    } catch (err) {
      const statusCode = httpStatusOf(err);
      if (statusCode === 401 || statusCode === 403) {
        // The pairing is gone server-side (2026-06-28 incident: results
        // for an invalidated session were retried forever with a dead
        // token). Latch + stop the relay so heartbeats/polling die too,
        // and SWALLOW the error — callers must not take their
        // catch-and-repost path against a dead pairing.
        this.pairingInvalid = true;
        process.stderr.write(
          '[codeam] This pairing is no longer valid — run `codeam pair` again to reconnect this session.\n',
        );
        log.warn('relay', `pairing invalid (status=${statusCode}) — relay stopped`);
        this.stop();
        return;
      }
      throw err;
    }
  }

  // ─── SSE pull (primary) ──────────────────────────────────────────

  private connectSSE(): void {
    if (!this._running) return;

    const url = new URL(`${API_BASE}/api/commands/pending/stream`);
    url.searchParams.set('pluginId', this.pluginId);
    const transport = url.protocol === 'https:' ? https : http;

    log.info('relay', `sse connect pluginId=${this.pluginId.slice(0, 8)}`);
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...vercelBypassHeader(),
          ...this.pollSecretHeader(),
        },
        timeout: 35_000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          log.info('relay', `sse status=${res.statusCode} — backing off`);
          res.resume();
          this.sseFailures += 1;
          if (this.sseFailures >= 2) {
            // Switch to polling fallback for this session.
            log.info('relay', 'sse unavailable — falling back to polling');
            capture('sse_fallback_to_poll', {
              pluginId: this.pluginId,
              agentId: this.agentMeta.id,
              reason: `status_${res.statusCode}`,
              failures: this.sseFailures,
            });
            this.startPollingFallback();
            return;
          }
          this.scheduleSseReconnect();
          return;
        }
        // 200 — reset failure counter; consume events.
        log.info('relay', 'sse connected');
        this.sseFailures = 0;
        // Command channel (re-)established — let the next beat's rider
        // re-assert immediately rather than waiting out its own throttle.
        this.heartbeatFirstAfterConnect = true;
        this.armSseWatchdog();
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          // ANY byte counts as liveness — text, ping events, comments.
          this.sseLastByteAt = Date.now();
          buffer += chunk;
          let frameEnd: number;
          while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, frameEnd);
            buffer = buffer.slice(frameEnd + 2);
            this.handleSseFrame(frame);
          }
        });
        res.on('end', () => {
          log.info('relay', 'sse end — reconnecting');
          this.disarmSseWatchdog();
          if (this._running) this.scheduleSseReconnect();
        });
        res.on('error', (err) => {
          log.info('relay', `sse res error — reconnecting (${(err as Error).message})`);
          this.disarmSseWatchdog();
          if (this._running) this.scheduleSseReconnect();
        });
      },
    );

    // Aggressive TCP keepalive — default macOS waits 2 hours before the
    // first keepalive probe. We tell the kernel to start probing after
    // 30 s of socket inactivity so a half-open peer (Cloud Run scale-
    // down, NAT drop, laptop sleep) is detected within ~60 s instead
    // of waiting for the per-spawn 60 s response timeout.
    req.on('socket', (socket) => {
      try {
        socket.setKeepAlive(true, 30_000);
      } catch {
        // older Node versions / mock sockets — best-effort
      }
    });

    req.on('error', (err) => {
      log.info('relay', `sse req error — ${(err as Error).message}`);
      this.disarmSseWatchdog();
      this.sseFailures += 1;
      if (this.sseFailures >= 2) {
        capture('sse_fallback_to_poll', {
          pluginId: this.pluginId,
          agentId: this.agentMeta.id,
          reason: 'req_error',
          failures: this.sseFailures,
        });
        this.startPollingFallback();
        return;
      }
      this.scheduleSseReconnect();
    });
    req.on('timeout', () => {
      log.info('relay', 'sse req timeout — destroying + reconnecting');
      req.destroy();
    });
    req.end();

    this.sseRequest = req;
  }

  // ─── SSE liveness watchdog ───────────────────────────────────────
  //
  // The server pings every 30 s; if more than SSE_LIVENESS_TIMEOUT_MS
  // pass without a byte, we assume the TCP peer is dead-zombie and
  // force the request to destroy → triggers `error`/`end` → standard
  // reconnect path. Without this, observed in the field: half-open
  // socket sits ESTABLISHED for 30 + minutes (until macOS default
  // 2 h TCP keepalive kicks in) and the CLI silently misses every
  // pushed command.
  private armSseWatchdog(): void {
    this.disarmSseWatchdog();
    this.sseLastByteAt = Date.now();
    this.sseWatchdog = setInterval(() => {
      const idle = Date.now() - this.sseLastByteAt;
      if (idle > SSE_LIVENESS_TIMEOUT_MS) {
        log.info('relay', `sse watchdog — ${idle}ms since last byte, forcing reconnect`);
        try {
          this.sseRequest?.destroy();
        } catch {
          // already dead
        }
        // destroy() emits error/end which the handlers above reconnect.
        this.disarmSseWatchdog();
      }
    }, SSE_WATCHDOG_INTERVAL_MS);
    this.sseWatchdog.unref?.();
  }

  private disarmSseWatchdog(): void {
    if (this.sseWatchdog) {
      clearInterval(this.sseWatchdog);
      this.sseWatchdog = null;
    }
  }

  private handleSseFrame(frame: string): void {
    let event = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (event !== 'commands' || !data) return;
    try {
      const parsed = JSON.parse(data) as { commands?: RemoteCommand[] };
      const commands = parsed.commands ?? [];
      if (commands.length === 0) return;
      log.info(
        'relay',
        `sse received ${commands.length} command(s) types=[${commands.map((c) => c.type).join(',')}]`,
      );
      void this.dispatchCommands(commands);
    } catch (err) {
      log.info('relay', 'sse parse error', err);
    }
  }

  private scheduleSseReconnect(): void {
    if (this.sseReconnectTimer) return;
    const delay = computePollDelay({ baseMs: 1000, failures: this.sseFailures });
    this.sseReconnectTimer = setTimeout(() => {
      this.sseReconnectTimer = null;
      this.connectSSE();
    }, delay);
  }

  // ─── Polling fallback ────────────────────────────────────────────

  private startPollingFallback(): void {
    if (this.pollTimer) return;
    // Same "channel (re-)established" signal SSE-connected raises — the
    // fallback is how this relay now reaches the backend.
    this.heartbeatFirstAfterConnect = true;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    if (!this._running) return;
    await this.pollOnce();
    if (this._running) {
      // Pick whichever streak is longer (failures vs empty) so the
      // backoff respects whichever signal is active. Cap empty at
      // a smaller exponent so a long idle CLI sits at ~30 s polls
      // instead of going to 5 min — fresh commands should still
      // land within the same poll cycle the user notices.
      const idleExp = Math.min(this.pollEmptyStreak, 4);
      const effectiveFailures = Math.max(this.pollFailures, idleExp);
      const delay = computePollDelay({ baseMs: 2000, failures: effectiveFailures });
      this.pollTimer = setTimeout(() => this.pollLoop(), delay);
    }
  }

  // SEC crit1 (#8): the command-delivery endpoints are gated on the
  // per-pairing pollSecret when the backend enforces it. Look it up from
  // the persisted session (keyed by this relay's pluginId) and replay it
  // as X-Plugin-Poll-Secret. Empty {} for legacy sessions / older
  // backends (which ignore it).
  private pollSecretHeader(): Record<string, string> {
    // Advertise at-least-once ack support on EVERY delivery request (SSE
    // subscribe + poll) so the backend delivers non-destructively and drains
    // only on our ack. Older backends ignore the unknown header (safe).
    const headers: Record<string, string> = { 'X-Codeam-Cmd-Ack': '1' };
    // An explicit secret (host-agent control channel — no session row exists
    // for its plugin) wins over the config lookup.
    if (this.explicitPollSecret) {
      headers['X-Plugin-Poll-Secret'] = this.explicitPollSecret;
      return headers;
    }
    try {
      const secret = loadCliConfig().sessions.find(
        (s) => s.pluginId === this.pluginId,
      )?.pollSecret;
      if (secret) headers['X-Plugin-Poll-Secret'] = secret;
    } catch {
      /* no secret — legacy session */
    }
    return headers;
  }

  private async pollOnce(): Promise<void> {
    try {
      const data = await _getJson(
        `${API_BASE}/api/commands/pending?pluginId=${this.pluginId}`,
        this.pollSecretHeader(),
      );
      const commands = data?.data as RemoteCommand[] | undefined;
      this.pollFailures = 0;
      if (!Array.isArray(commands) || commands.length === 0) {
        this.pollEmptyStreak += 1;
        return;
      }
      // Real work arrived — collapse both streaks so the next poll
      // fires at the base 2 s cadence and the user feels snappy.
      this.pollEmptyStreak = 0;
      log.trace('relay', `poll received ${commands.length} command(s)`);
      await this.dispatchCommands(commands);
    } catch (err) {
      this.pollFailures += 1;
      log.trace('relay', `poll failed (failures=${this.pollFailures})`, err);
    }
  }

  private async dispatchCommands(commands: RemoteCommand[]): Promise<void> {
    // Ack EVERY received id first (even ones we dedupe below) so the backend
    // drains its queue — at-least-once delivery means the command stays queued
    // until we confirm receipt. Best-effort + non-blocking: a failed ack just
    // means a harmless redelivery (we dedupe it). Fire before dispatch so a slow
    // handler can't hold the command on the server queue.
    this.ackCommands(commands.map((c) => c.id));

    for (const cmd of commands) {
      // Dedupe: at-least-once delivery can redeliver (reconnect, publish
      // re-fire, ghost-subscriber race). Skip anything we've already run so a
      // redelivered "post to Slack" can't double-execute.
      if (cmd.id && this.processedIds.has(cmd.id)) {
        log.trace('relay', `dedupe skip already-dispatched id=${cmd.id}`);
        continue;
      }
      if (cmd.id) this.rememberProcessed(cmd.id);
      try {
        log.trace('relay', `dispatch type=${cmd.type} id=${cmd.id}`);
        await this.onCommand(cmd);
      } catch (err) {
        log.trace('relay', 'command handler threw', err);
      }
    }
  }

  /** Record a dispatched id, evicting the oldest when over the cap (FIFO). */
  private rememberProcessed(id: string): void {
    this.processedIds.add(id);
    if (this.processedIds.size > CommandRelayService.PROCESSED_ID_CAP) {
      const oldest = this.processedIds.values().next().value;
      if (oldest !== undefined) this.processedIds.delete(oldest);
    }
  }

  /** Confirm receipt of command ids so the backend removes them from the queue
   *  (the at-least-once delivery guarantee). Best-effort — never throws.
   *
   * ⚠️ A ONE-OFF failure here is harmless (the command redelivers and we dedupe),
   * but a PERSISTENT one is not: the queue never drains, so every batch is
   * redelivered forever and the host looks perfectly healthy from outside —
   * heartbeats land, commands still arrive, `status` stays `online`. That is
   * exactly how the fleet host ran from 2026-07-15 to 2026-08-31 with NO poll
   * secret enrolled, 401-ing every single ack, with nobody the wiser: the
   * failure lived in `log.trace`, below the level anyone reads.
   *
   * So: keep it best-effort, but make a SUSTAINED failure impossible to miss,
   * and name `PLUGIN_SECRET_REQUIRED` explicitly — it is not a network blip,
   * it is a host that must be re-enrolled and will never recover on its own.
   */
  private ackCommands(ids: string[]): void {
    const commandIds = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (commandIds.length === 0) return;
    void _postJson(`${API_BASE}/api/commands/ack`, { pluginId: this.pluginId, commandIds }, {
      ...this.pollSecretHeader(),
    })
      .then(() => {
        if (this.ackFailures > 0) {
          log.warn('relay', `ack recovered after ${this.ackFailures} consecutive failure(s)`);
          this.ackFailures = 0;
        }
      })
      .catch((err: unknown) => {
        this.ackFailures += 1;
        const reason = err instanceof Error ? err.message : String(err);
        // A host whose secret was never enrolled can NEVER self-recover by
        // retrying — say so the first time instead of burying it in a counter.
        if (/PLUGIN_SECRET_REQUIRED|INVALID_PLUGIN_SECRET/.test(reason)) {
          log.warn(
            'relay',
            `ack REJECTED (${reason}) — this host needs to be re-paired; ` +
              'commands will be redelivered forever until it is',
          );
          return;
        }
        if (this.ackFailures === 1 || this.ackFailures % CommandRelayService.ACK_WARN_EVERY === 0) {
          log.warn(
            'relay',
            `ack failed ${this.ackFailures}x in a row — the backend queue is not draining: ${reason}`,
          );
          return;
        }
        log.trace('relay', 'ack post failed (will redeliver+dedupe)', err);
      });
  }

  // ─── Heartbeat + agents ──────────────────────────────────────────

  private async sendHeartbeat(online: boolean): Promise<void> {
    // `agentId` lets the backend fire the auto-link side-effect when
    // the user hasn't vaulted credentials for this agent yet. The
    // server normalizes between the internal id (e.g. `claude`) and
    // the public LinkedAgentId (e.g. `claude_code`). Older backends
    // simply ignore the extra field.
    //
    // `branch` re-reads the working dir's git branch on every tick so
    // `git checkout` propagates to the mobile / web WORKSPACE rail
    // within one heartbeat (~20 s). detectCurrentBranch is ~10 ms on
    // a healthy repo (execFileSync `git branch --show-current` with a
    // 1 s timeout); the backend dedupes — a stable branch costs only
    // the bytes on the wire.
    await _postJson(`${API_BASE}/api/plugin/heartbeat`, {
      pluginId: this.pluginId,
      online,
      agentId: this.agentMeta.id,
      branch: this.cachedBranch,
      // Report our own version so the backend can keep PairedSession.ideVersion
      // fresh + clear the "CLI update available" banner after a self-update
      // (a codespace that reinstalls @latest reconnects via heartbeat, not
      // pair/reconnect). Older backends ignore the extra field.
      ...(typeof __CLI_VERSION__ !== 'undefined' && __CLI_VERSION__
        ? { ideVersion: __CLI_VERSION__ }
        : {}),
    })
      .then(() => log.trace('relay', `heartbeat ok online=${online}`))
      .catch((err: unknown) => log.trace('relay', `heartbeat failed online=${online}`, err));
  }

  /**
   * Refresh {@link cachedBranch} without blocking the event loop.
   * Fire-and-forget from the heartbeat tick; failures leave the last
   * known value in place (the backend dedupes a stable branch).
   */
  private async refreshBranch(): Promise<void> {
    try {
      this.cachedBranch = await detectCurrentBranchAsync();
    } catch {
      // detectCurrentBranchAsync never rejects, but guard anyway —
      // keep the previous cached value on any unexpected failure.
    }
  }

  private reportAgents(): void {
    // The mobile + landing AgentIcon components key their per-agent
    // logo map by the agent id, so send the id as the icon key. The
    // emoji that used to ship here was only ever rendered by the
    // landing fallback path and never surfaced to the user.
    const agents = this.agentsOverride
      ? [...this.agentsOverride]
      : [
          {
            id: this.agentMeta.id,
            name: this.agentMeta.displayName,
            icon: this.agentMeta.id,
            installed: true,
          },
        ];
    _postJson(`${API_BASE}/api/plugin/agents`, {
      pluginId: this.pluginId,
      agents,
      capabilities: { squad: true },
    })
      .then(() => { this.agentsRegistered = true; })
      .catch(() => { /* retry via agentsTimer */ });
  }

  /**
   * Swap the agent this relay reports for the session (in-session agent
   * switch). Heartbeats pick the new id up on their next tick; call
   * {@link reannounceAgents} to push the new `/api/plugin/agents` entry.
   */
  setAgentMeta(meta: AgentMetadata): void {
    this.agentMeta = meta;
  }

  /**
   * Re-register the (possibly swapped) agent with the backend. Resets
   * `agentsRegistered` so the 5 s retry timer keeps trying until a POST
   * lands — same at-least-once semantics as the initial registration.
   */
  reannounceAgents(): void {
    this.agentsRegistered = false;
    this.reportAgents();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  private cleanup(): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.agentsTimer) { clearInterval(this.agentsTimer); this.agentsTimer = null; }
    if (this.headroomSupervisorTimer) { clearInterval(this.headroomSupervisorTimer); this.headroomSupervisorTimer = null; }
    if (this.sseReconnectTimer) { clearTimeout(this.sseReconnectTimer); this.sseReconnectTimer = null; }
    this.disarmSseWatchdog();
    if (this.sseRequest) {
      try { this.sseRequest.destroy(); } catch { /* ignore */ }
      this.sseRequest = null;
    }
  }
}


/**
 * How long a shutdown path may wait for the goodbye heartbeat before exiting
 * anyway. Long enough for a normal round-trip, short enough that Ctrl+C still
 * feels instant on a dead network.
 */
export const RELAY_GOODBYE_TIMEOUT_MS = 1500;

/**
 * Stop the relay and WAIT (bounded) for its `online:false` heartbeat to land.
 * The one thing every `process.exit()` shutdown path must do so mobile flips
 * the session to offline immediately instead of waiting out a Redis TTL that
 * nothing publishes on. Never throws.
 */
export async function stopRelayWithGoodbye(
  relay: Pick<CommandRelayService, 'stopAndFlush'>,
  timeoutMs: number = RELAY_GOODBYE_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      relay.stopAndFlush(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    /* best-effort — never block an exit on the goodbye */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

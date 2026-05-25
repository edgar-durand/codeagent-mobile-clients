import * as https from 'https';
import * as http from 'http';
import { resolveApiBaseUrl } from '@codeagent/shared';
import type { AgentMetadata } from '@codeagent/shared';
import { _postJson, _getJson } from './pairing.service';
import { vercelBypassHeader } from '../lib/backend-headers';
import { computePollDelay } from '../lib/poll-delay';
import { detectCurrentBranch } from '../lib/git-branch';
import { log } from './logger';
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
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private agentsTimer: NodeJS.Timeout | null = null;
  /** True once `/api/plugin/agents` has accepted at least one report. */
  private agentsRegistered = false;
  /** SSE connection (null when on the polling fallback or stopped). */
  private sseRequest: http.ClientRequest | null = null;
  /** Polling backoff state (only used on the fallback). */
  private pollTimer: NodeJS.Timeout | null = null;
  private pollFailures = 0;
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
     */
    private readonly agentMeta: AgentMetadata,
  ) {}

  start(): void {
    this.cleanup();

    this._running = true;
    this.agentsRegistered = false;
    log.info('relay', `start pluginId=${this.pluginId.slice(0, 8)} agent=${this.agentMeta.id}`);
    this.sendHeartbeat(true);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(true), 20_000);
    this.agentsTimer = setInterval(() => {
      if (this._running && !this.agentsRegistered) this.reportAgents();
    }, 5_000);
    this.reportAgents();

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

  stop(): void {
    if (!this._running) return;
    this._running = false;
    this.cleanup();
    this.sendHeartbeat(false).catch(() => {});
  }

  async sendResult(
    commandId: string,
    status: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await _postJson(`${API_BASE}/api/commands/result`, { commandId, status, result });
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
        headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', ...vercelBypassHeader() },
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

  private async pollOnce(): Promise<void> {
    try {
      const data = await _getJson(`${API_BASE}/api/commands/pending?pluginId=${this.pluginId}`);
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
    for (const cmd of commands) {
      try {
        log.trace('relay', `dispatch type=${cmd.type} id=${cmd.id}`);
        await this.onCommand(cmd);
      } catch (err) {
        log.trace('relay', 'command handler threw', err);
      }
    }
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
      branch: detectCurrentBranch(),
    })
      .then(() => log.trace('relay', `heartbeat ok online=${online}`))
      .catch((err: unknown) => log.trace('relay', `heartbeat failed online=${online}`, err));
  }

  private reportAgents(): void {
    // The mobile + landing AgentIcon components key their per-agent
    // logo map by the agent id, so send the id as the icon key. The
    // emoji that used to ship here was only ever rendered by the
    // landing fallback path and never surfaced to the user.
    _postJson(`${API_BASE}/api/plugin/agents`, {
      pluginId: this.pluginId,
      agents: [
        {
          id: this.agentMeta.id,
          name: this.agentMeta.displayName,
          icon: this.agentMeta.id,
          installed: true,
        },
      ],
    })
      .then(() => { this.agentsRegistered = true; })
      .catch(() => { /* retry via agentsTimer */ });
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  private cleanup(): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.agentsTimer) { clearInterval(this.agentsTimer); this.agentsTimer = null; }
    if (this.sseReconnectTimer) { clearTimeout(this.sseReconnectTimer); this.sseReconnectTimer = null; }
    this.disarmSseWatchdog();
    if (this.sseRequest) {
      try { this.sseRequest.destroy(); } catch { /* ignore */ }
      this.sseRequest = null;
    }
  }
}

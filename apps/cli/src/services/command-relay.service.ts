import * as https from 'https';
import * as http from 'http';
import { _postJson, _getJson } from './pairing.service';
import { computePollDelay } from '../lib/poll-delay';
import { log } from './logger';

const API_BASE = process.env.CODEAM_API_URL ?? 'https://codeagent-mobile-api.vercel.app';

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
  /** Reconnect backoff state for the SSE stream. */
  private sseFailures = 0;
  private sseReconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pluginId: string,
    private readonly onCommand: (cmd: RemoteCommand) => void | Promise<void>,
  ) {}

  start(): void {
    this.cleanup();

    this._running = true;
    this.agentsRegistered = false;
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

    log.trace('relay', `sse connect ${url.pathname}`);
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
        timeout: 35_000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          log.trace('relay', `sse status=${res.statusCode}`);
          res.resume();
          this.sseFailures += 1;
          if (this.sseFailures >= 2) {
            // Switch to polling fallback for this session.
            log.trace('relay', 'sse unavailable, falling back to polling');
            this.startPollingFallback();
            return;
          }
          this.scheduleSseReconnect();
          return;
        }
        // 200 — reset failure counter; consume events.
        this.sseFailures = 0;
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let frameEnd: number;
          while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, frameEnd);
            buffer = buffer.slice(frameEnd + 2);
            this.handleSseFrame(frame);
          }
        });
        res.on('end', () => {
          // Server-initiated close (Vercel timeout). Reconnect.
          if (this._running) this.scheduleSseReconnect();
        });
        res.on('error', () => {
          if (this._running) this.scheduleSseReconnect();
        });
      },
    );

    req.on('error', (err) => {
      log.trace('relay', 'sse req error', err);
      this.sseFailures += 1;
      if (this.sseFailures >= 2) {
        this.startPollingFallback();
        return;
      }
      this.scheduleSseReconnect();
    });
    req.on('timeout', () => { req.destroy(); });
    req.end();

    this.sseRequest = req;
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
      log.trace('relay', `sse received ${commands.length} command(s)`);
      void this.dispatchCommands(commands);
    } catch (err) {
      log.trace('relay', 'sse parse error', err);
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
      const delay = computePollDelay({ baseMs: 2000, failures: this.pollFailures });
      this.pollTimer = setTimeout(() => this.pollLoop(), delay);
    }
  }

  private async pollOnce(): Promise<void> {
    try {
      const data = await _getJson(`${API_BASE}/api/commands/pending?pluginId=${this.pluginId}`);
      const commands = data?.data as RemoteCommand[] | undefined;
      this.pollFailures = 0;
      if (!Array.isArray(commands) || commands.length === 0) return;
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
    await _postJson(`${API_BASE}/api/plugin/heartbeat`, {
      pluginId: this.pluginId,
      online,
    })
      .then(() => log.trace('relay', `heartbeat ok online=${online}`))
      .catch((err: unknown) => log.trace('relay', `heartbeat failed online=${online}`, err));
  }

  private reportAgents(): void {
    _postJson(`${API_BASE}/api/plugin/agents`, {
      pluginId: this.pluginId,
      agents: [{ id: 'claude-code', name: 'Claude Code', icon: '🤖', installed: true }],
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
    if (this.sseRequest) {
      try { this.sseRequest.destroy(); } catch { /* ignore */ }
      this.sseRequest = null;
    }
  }
}

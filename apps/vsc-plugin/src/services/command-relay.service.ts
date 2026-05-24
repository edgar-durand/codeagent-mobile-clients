import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';
import { SettingsService } from './settings.service';
import { OutputChannel } from 'vscode';

export interface RemoteCommand {
  id: string;
  sessionId: string;
  pluginId: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  createdAt: number;
}

export interface CommandListener {
  onCommandReceived(command: RemoteCommand): void;
}

export class CommandRelayService {
  private static instance: CommandRelayService;
  // Polling is the FALLBACK path. SSE is preferred — see
  // `connectSSE`. When SSE is available, `pollTimer` stays null
  // and the plugin generates effectively zero API load while
  // idle (one held HTTP/2 connection per plugin instead of one
  // GET every 2 s). Polling kicks in when SSE fails twice in a
  // row (server returned a non-200, network refused, etc.).
  private pollTimer: NodeJS.Timeout | null = null;
  private pollFailures = 0;
  private pollEmptyStreak = 0;
  private sseRequest: http.ClientRequest | null = null;
  private sseReconnectTimer: NodeJS.Timeout | null = null;
  private sseFailures = 0;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private listeners: CommandListener[] = [];
  private log: OutputChannel;
  private _running = false;
  // Set when the backend has returned 401 for the current token. Stops
  // every transport (SSE, polling, heartbeat) until the user re-pairs,
  // and throttles the "session expired" notification to once per
  // process — repeating it every poll would spam.
  private authFailureSurfaced = false;

  private constructor(log: OutputChannel) {
    this.log = log;
  }

  static initialize(log: OutputChannel): CommandRelayService {
    CommandRelayService.instance = new CommandRelayService(log);
    return CommandRelayService.instance;
  }

  static getInstance(): CommandRelayService {
    if (!CommandRelayService.instance) {
      throw new Error('CommandRelayService not initialized');
    }
    return CommandRelayService.instance;
  }

  get isPolling(): boolean {
    return this._running;
  }

  addListener(listener: CommandListener): void {
    this.listeners.push(listener);
  }

  startPolling(): void {
    this.stopPolling();
    this._running = true;
    // Try SSE first; fall back to short polling only if SSE fails
    // twice (counted inside connectSSE / scheduleSseReconnect).
    this.connectSSE();
    this.startHeartbeat();
    this.log.appendLine('Command relay started (SSE primary, polling fallback)');
  }

  stopPolling(): void {
    this._running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = null;
    }
    if (this.sseRequest) {
      try { this.sseRequest.destroy(); } catch { /* ignore */ }
      this.sseRequest = null;
    }
    this.pollFailures = 0;
    this.pollEmptyStreak = 0;
    this.sseFailures = 0;
    this.stopHeartbeat();
  }

  // ─── SSE pull (primary) ────────────────────────────────────────
  //
  // Subscribes to `/api/commands/pending/stream` and receives a
  // server-pushed `event: commands` frame whenever the backend
  // queues a command for this pluginId. No timer ticking, no
  // wasted invocations on the API side. One held connection per
  // plugin; the server tears the stream after ~30 s (Vercel SSE
  // timeout) and we auto-reconnect. After two consecutive
  // failures we drop to the polling fallback so the plugin
  // never gets stranded if the SSE endpoint is broken.

  private connectSSE(): void {
    if (!this._running) return;

    const settings = SettingsService.getInstance();
    const pluginId = settings.ensurePluginId();
    const apiBase = settings.apiBaseUrl;
    const url = new URL(`${apiBase}/api/commands/pending/stream`);
    url.searchParams.set('pluginId', pluginId);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...this.authHeaders(),
        },
        timeout: 35_000,
      },
      (res) => {
        if (res.statusCode === 401) {
          res.resume();
          this.handleAuthFailure();
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          this.sseFailures += 1;
          if (this.sseFailures >= 2) {
            this.log.appendLine(`SSE unavailable (status=${res.statusCode}); falling back to polling`);
            this.startPollingFallback();
            return;
          }
          this.scheduleSseReconnect();
          return;
        }
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
          // Server-initiated close (Vercel timeout). Reconnect
          // on the same path.
          if (this._running) this.scheduleSseReconnect();
        });
        res.on('error', () => {
          if (this._running) this.scheduleSseReconnect();
        });
      },
    );

    req.on('error', () => {
      this.sseFailures += 1;
      if (this.sseFailures >= 2) {
        this.log.appendLine('SSE request error; falling back to polling');
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
      const parsed = JSON.parse(data) as { commands?: Array<Record<string, unknown>> };
      const raw = parsed.commands ?? [];
      if (raw.length === 0) return;
      for (const obj of raw) {
        const cmd: RemoteCommand = {
          id: obj.id as string,
          sessionId: obj.sessionId as string,
          pluginId: obj.pluginId as string,
          type: obj.type as string,
          payload: (obj.payload as Record<string, unknown>) || {},
          status: obj.status as string,
          createdAt: obj.createdAt as number,
        };
        this.listeners.forEach((l) => l.onCommandReceived(cmd));
      }
    } catch {
      /* malformed frame — wait for the next one */
    }
  }

  private scheduleSseReconnect(): void {
    if (this.sseReconnectTimer) return;
    // 1 s base, capped via 2^failures up to ~30 s with jitter
    const exp = Math.min(30_000, 1000 * Math.pow(2, this.sseFailures));
    const delay = Math.round(exp * (0.9 + Math.random() * 0.2));
    this.sseReconnectTimer = setTimeout(() => {
      this.sseReconnectTimer = null;
      this.connectSSE();
    }, delay);
  }

  // ─── Polling fallback ──────────────────────────────────────────

  private startPollingFallback(): void {
    if (this.pollTimer) return;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    if (!this._running) return;
    await this.pollOnce();
    if (this._running) {
      // Same idle-backoff strategy as the CLI: use whichever
      // streak is longer (failures vs successive empty polls,
      // capped) to scale the delay. Floor at 2 s base, cap at
      // 30 s.
      const idleExp = Math.min(this.pollEmptyStreak, 4);
      const effective = Math.max(this.pollFailures, idleExp);
      const exp = Math.min(30_000, 2000 * Math.pow(2, effective));
      const delay = Math.round(exp * (0.9 + Math.random() * 0.2));
      this.pollTimer = setTimeout(() => this.pollLoop(), delay);
    }
  }

  private async pollOnce(): Promise<void> {
    const settings = SettingsService.getInstance();
    const pluginId = settings.ensurePluginId();
    try {
      const data = await this.getJson(`${settings.apiBaseUrl}/api/commands/pending?pluginId=${pluginId}`);
      const commands = data?.data as Array<Record<string, unknown>> | undefined;
      this.pollFailures = 0;
      if (!Array.isArray(commands) || commands.length === 0) {
        this.pollEmptyStreak += 1;
        return;
      }
      this.pollEmptyStreak = 0;
      for (const obj of commands) {
        const cmd: RemoteCommand = {
          id: obj.id as string,
          sessionId: obj.sessionId as string,
          pluginId: obj.pluginId as string,
          type: obj.type as string,
          payload: (obj.payload as Record<string, unknown>) || {},
          status: obj.status as string,
          createdAt: obj.createdAt as number,
        };
        this.log.appendLine(`Received command: ${cmd.type} (${cmd.id})`);
        this.listeners.forEach((l) => l.onCommandReceived(cmd));
      }
    } catch {
      this.pollFailures += 1;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.reportOnline();
    this.heartbeatInterval = setInterval(() => this.reportOnline(), 20000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private reportOnline(): void {
    const settings = SettingsService.getInstance();
    const pluginId = settings.ensurePluginId();
    this.postJson(`${settings.apiBaseUrl}/api/plugin/heartbeat`, {
      pluginId,
      online: true,
    }).catch(() => {});
  }

  reportAgents(agents: Array<{ id: string; name: string; icon: string; installed: boolean }>): void {
    const settings = SettingsService.getInstance();
    const pluginId = settings.ensurePluginId();
    this.postJson(`${settings.apiBaseUrl}/api/plugin/agents`, {
      pluginId,
      agents,
    }).then(() => {
      this.log.appendLine(`Reported ${agents.length} agents to API`);
    }).catch((e) => {
      this.log.appendLine(`Failed to report agents: ${e}`);
    });
  }

  reportOffline(): void {
    const settings = SettingsService.getInstance();
    const pluginId = settings.ensurePluginId();
    this.postJson(`${settings.apiBaseUrl}/api/plugin/heartbeat`, {
      pluginId,
      online: false,
    }).catch(() => {});
  }

  async sendResult(commandId: string, status: string, result: Record<string, unknown>): Promise<void> {
    const settings = SettingsService.getInstance();
    try {
      await this.postJson(`${settings.apiBaseUrl}/api/commands/result`, {
        commandId,
        status,
        result,
      });
    } catch (e) {
      this.log.appendLine(`Failed to send command result: ${e}`);
    }
  }

  /**
   * Headers we attach to every authed call. The auth token is the
   * per-pairing secret returned at pair time; the protocol-version
   * header lets the backend route legacy translations or 426-us
   * when we drift too far.
   *
   * Public so other services (terminal-agent, chat-history) can
   * apply the same headers to their own postJson calls without
   * redefining them.
   */
  authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Codeam-Protocol-Version': '2.0.0',
    };
    const token = SettingsService.getInstance().getPluginAuthToken();
    if (token) {
      headers['X-Plugin-Auth-Token'] = token;
    }
    return headers;
  }

  async postJson(url: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const urlObj = new URL(url);
      const transport = urlObj.protocol === 'https:' ? https : http;

      const req = transport.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname + urlObj.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            ...this.authHeaders(),
          },
          timeout: 10000,
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode === 401) {
              this.handleAuthFailure();
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(responseBody));
            } catch {
              resolve(null);
            }
          });
        },
      );

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(data);
      req.end();
    });
  }

  private async getJson(url: string): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const transport = urlObj.protocol === 'https:' ? https : http;

      const req = transport.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          headers: this.authHeaders(),
          timeout: 10000,
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode === 401) {
              this.handleAuthFailure();
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(responseBody));
            } catch {
              resolve(null);
            }
          });
        },
      );

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  /**
   * Triggered when the backend returns 401 from any HTTP path or SSE
   * upgrade. The token the plugin holds is dead (rotated server-side
   * or invalidated from the mobile app), so:
   *
   *   - drop the cached token so subsequent calls don't replay it
   *   - stop every transport: polling, SSE, heartbeat
   *   - tell the user once per process; the action button opens the
   *     pairing panel
   *
   * The dispatcher reads `getPluginAuthToken()` for the next pair
   * attempt and will receive null until the user re-pairs.
   */
  private handleAuthFailure(): void {
    SettingsService.getInstance().setPluginAuthToken(null);
    this.stopPolling();
    if (this.authFailureSurfaced) return;
    this.authFailureSurfaced = true;
    this.log.appendLine('Auth failed (401) — token cleared, polling stopped.');
    void vscode.window
      .showWarningMessage(
        'CodeAgent Mobile · Session expired. Re-pair to continue.',
        'Re-pair',
      )
      .then((choice) => {
        if (choice === 'Re-pair') {
          void vscode.commands.executeCommand('codeagent-mobile.openPanel');
        }
      });
  }

  /** Called from PairingService once a new token has been stored. */
  resetAuthFailureGate(): void {
    this.authFailureSurfaced = false;
  }
}

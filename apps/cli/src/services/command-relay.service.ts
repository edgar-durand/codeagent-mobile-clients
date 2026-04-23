import { _postJson, _getJson } from './pairing.service';

const API_BASE = process.env.CODEAM_API_URL ?? 'https://codeagent-mobile-api.vercel.app';

export interface RemoteCommand {
  id: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
}

export class CommandRelayService {
  private _running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pluginId: string,
    private readonly onCommand: (cmd: RemoteCommand) => void | Promise<void>,
  ) {}

  start(): void {
    // Tear down any existing timers directly — no offline heartbeat during restart
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

    this._running = true;
    this.sendHeartbeat(true);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(true), 20_000);
    void this.pollLoop();
    this.reportAgents();
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.sendHeartbeat(false).catch(() => {});
  }

  async sendResult(
    commandId: string,
    status: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await _postJson(`${API_BASE}/api/commands/result`, { commandId, status, result });
  }

  private async pollLoop(): Promise<void> {
    if (!this._running) return;
    await this.poll();
    if (this._running) {
      this.pollTimer = setTimeout(() => this.pollLoop(), 2000);
    }
  }

  private async poll(): Promise<void> {
    try {
      const data = await _getJson(
        `${API_BASE}/api/commands/pending?pluginId=${this.pluginId}`,
      );
      const commands = data?.data as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(commands)) return;
      for (const obj of commands) {
        try {
          await this.onCommand({
            id: obj.id as string,
            sessionId: obj.sessionId as string,
            type: obj.type as string,
            payload: (obj.payload as Record<string, unknown>) ?? {},
          });
        } catch { /* command handler error – continue with next */ }
      }
    } catch { /* silent */ }
  }

  private async sendHeartbeat(online: boolean): Promise<void> {
    await _postJson(`${API_BASE}/api/plugin/heartbeat`, {
      pluginId: this.pluginId,
      online,
    }).catch(() => {});
  }

  private reportAgents(): void {
    _postJson(`${API_BASE}/api/plugin/agents`, {
      pluginId: this.pluginId,
      agents: [{ id: 'claude-code', name: 'Claude Code', icon: '🤖', installed: true }],
    }).catch(() => {});
  }
}

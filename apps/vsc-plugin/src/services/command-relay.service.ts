import * as https from 'https';
import * as http from 'http';
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
  private pollInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private listeners: CommandListener[] = [];
  private log: OutputChannel;
  private _isPolling = false;

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
    return this._isPolling;
  }

  addListener(listener: CommandListener): void {
    this.listeners.push(listener);
  }

  startPolling(): void {
    this.stopPolling();
    this._isPolling = true;
    this.pollInterval = setInterval(() => this.fetchPendingCommands(), 2000);
    this.fetchPendingCommands();
    this.startHeartbeat();
    this.log.appendLine('Command polling started');
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.stopHeartbeat();
    this._isPolling = false;
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

  private async fetchPendingCommands(): Promise<void> {
    const settings = SettingsService.getInstance();
    const pluginId = settings.ensurePluginId();

    try {
      const data = await this.getJson(`${settings.apiBaseUrl}/api/commands/pending?pluginId=${pluginId}`);
      const commands = data?.data as Array<Record<string, unknown>> | undefined;
      if (!commands || !Array.isArray(commands)) { return; }

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
    } catch (e) {
      // Silent polling error
    }
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
          },
          timeout: 10000,
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
          res.on('end', () => {
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
          timeout: 10000,
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
          res.on('end', () => {
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
}

import * as vscode from 'vscode';
import * as os from 'os';
import { SettingsService, RecentSession } from './settings.service';
import { CommandRelayService } from './command-relay.service';
import { OutputChannel } from 'vscode';

export interface PairedUserInfo {
  name: string;
  email: string;
  plan: string;
  currentPeriodEnd?: string;
}

export interface PairingListener {
  onPaired(sessionId: string): void;
}

export class PairingService {
  private static instance: PairingService;
  private pollInterval: NodeJS.Timeout | null = null;
  private pollTimeout: NodeJS.Timeout | null = null;
  private listeners: PairingListener[] = [];
  private log: OutputChannel;

  pairedUser: PairedUserInfo | null = null;
  currentSessionId: string | null = null;

  private constructor(log: OutputChannel) {
    this.log = log;
  }

  static initialize(log: OutputChannel): PairingService {
    PairingService.instance = new PairingService(log);
    return PairingService.instance;
  }

  static getInstance(): PairingService {
    if (!PairingService.instance) {
      throw new Error('PairingService not initialized');
    }
    return PairingService.instance;
  }

  addListener(listener: PairingListener): void {
    this.listeners.push(listener);
  }

  async requestPairingCode(): Promise<{ code: string; expiresAt: number } | null> {
    const settings = SettingsService.getInstance();
    const pluginId = settings.ensurePluginId();
    const relay = CommandRelayService.getInstance();

    try {
      const result = await relay.postJson(`${settings.apiBaseUrl}/api/pairing/code`, {
        pluginId,
        ideName: 'VS Code',
        ideVersion: vscode.version,
        hostname: os.hostname(),
      });

      if (result?.data) {
        const data = result.data as Record<string, unknown>;
        const code = data.code as string;
        const expiresAt = data.expiresAt as number;

        this.startPollingForPairing();
        return { code, expiresAt };
      }
      return null;
    } catch (e) {
      this.log.appendLine(`Error requesting pairing code: ${e}`);
      return null;
    }
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }

  private startPollingForPairing(): void {
    this.stopPolling();
    this.pollInterval = setInterval(() => this.checkPairingStatus(), 3000);
    this.pollTimeout = setTimeout(() => this.stopPolling(), 300_000);
  }

  private async checkPairingStatus(): Promise<void> {
    const settings = SettingsService.getInstance();
    const pluginId = settings.ensurePluginId();

    try {
      const result = await this.getJson(`${settings.apiBaseUrl}/api/pairing/status?pluginId=${pluginId}`);

      if (result?.data) {
        const data = result.data as Record<string, unknown>;
        const paired = data.paired as boolean;

        if (paired) {
          const sessionId = data.sessionId as string;
          const userObj = data.user as Record<string, unknown> | undefined;

          if (userObj) {
            this.pairedUser = {
              name: (userObj.name as string) || '',
              email: (userObj.email as string) || '',
              plan: (userObj.plan as string) || 'FREE',
              currentPeriodEnd: userObj.currentPeriodEnd as string | undefined,
            };
          }

          this.currentSessionId = sessionId;
          this.log.appendLine(`Pairing detected! Session: ${sessionId}, user: ${this.pairedUser?.email}`);
          this.stopPolling();
          this.saveCurrentSession();
          this.listeners.forEach((l) => l.onPaired(sessionId));
        }
      }
    } catch (e) {
      // Silent polling error
    }
  }

  private saveCurrentSession(): void {
    if (!this.currentSessionId || !this.pairedUser) { return; }
    const settings = SettingsService.getInstance();
    settings.addRecentSession({
      sessionId: this.currentSessionId,
      userName: this.pairedUser.name,
      userEmail: this.pairedUser.email,
      userPlan: this.pairedUser.plan,
      connectedAt: Date.now(),
    });
  }

  clearCurrentSession(): void {
    this.currentSessionId = null;
    this.pairedUser = null;
  }

  onReconnected(sessionId: string, user: PairedUserInfo): void {
    this.currentSessionId = sessionId;
    this.pairedUser = user;
    this.saveCurrentSession();
    this.listeners.forEach((l) => l.onPaired(sessionId));
  }

  private async getJson(url: string): Promise<Record<string, unknown> | null> {
    const https = require('https');
    const http = require('http');
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
        (res: any) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch { resolve(null); }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  }
}

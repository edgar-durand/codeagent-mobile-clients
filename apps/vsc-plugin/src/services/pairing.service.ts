import * as vscode from 'vscode';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { PROTOCOL_VERSION } from '@codeam/shared';
import { SettingsService, type RecentSession } from './settings.service';
import { CommandRelayService } from './command-relay.service';
import { checkApiReachable } from './connectivity';
import { OutputChannel } from 'vscode';

export type PairingCodeResult = { code: string; expiresAt: number } | { blocked: true } | null;

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

  async requestPairingCode(): Promise<PairingCodeResult> {
    const settings = SettingsService.getInstance();
    const pluginId = settings.ensurePluginId();
    const relay = CommandRelayService.getInstance();

    // Preflight: if the API host is unreachable (VPN/firewall/allowlist),
    // surface the cloud fallback instead of a cryptic pairing failure.
    if ((await checkApiReachable(settings.apiBaseUrl)) === 'blocked') {
      this.log.appendLine('[pairing] API unreachable (preflight) — offering cloud fallback');
      return { blocked: true };
    }

    let branch: string | null = null;
    try {
      const { ProjectOpsService } = await import('./project-ops.service');
      branch = await ProjectOpsService.detectCurrentBranch();
    } catch { /* branch unknown */ }

    try {
      const result = await relay.postJson(`${settings.apiBaseUrl}/api/pairing/code`, {
        pluginId,
        ideName: 'VS Code',
        ideVersion: vscode.version,
        hostname: os.hostname(),
        branch,
        // SEC crit1 (#813): enroll the PoP hash so /status + /reconnect
        // require this window's secret. Older backends ignore it.
        pluginSecretHash: crypto
          .createHash('sha256')
          .update(settings.ensurePollSecret())
          .digest('hex'),
      });

      if (result?.data) {
        const data = result.data as Record<string, unknown>;
        const code = data.code;
        const expiresAt = data.expiresAt;
        if (typeof code === 'string' && typeof expiresAt === 'number') {
          this.startPollingForPairing();
          return { code, expiresAt };
        }
      }
      return null;
    } catch (e) {
      // postJson rejects ONLY on transport error/timeout (it resolves on any
      // HTTP response), so a throw here means no HTTP response = blocked.
      this.log.appendLine(`[pairing] request failed (transport) — offering cloud fallback: ${e}`);
      return { blocked: true };
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
      // SEC crit1 (#813): replay this window's PoP secret so the gated
      // /status returns the token + PII (the VSC plugin reads the token
      // from here). Legacy backends ignore the header.
      const result = await this.getJson(
        `${settings.apiBaseUrl}/api/pairing/status?pluginId=${pluginId}`,
        { 'X-Plugin-Poll-Secret': settings.ensurePollSecret() },
      );

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

          // Persist the per-pairing token. Replayed as
          // `X-Plugin-Auth-Token` on every authed call so we still
          // pass auth after the legacy fallback expires (2026-05-25).
          const rawToken = data.pluginAuthToken;
          if (typeof rawToken === 'string' && rawToken.length > 0) {
            SettingsService.getInstance().setPluginAuthToken(rawToken);
            this.log.appendLine(
              `[pairing] Stored pluginAuthToken (${rawToken.length} chars)`,
            );
            // The new token clears any prior 401 — re-arm the
            // "session expired" toast for the next failure.
            CommandRelayService.getInstance().resetAuthFailureGate();
          } else {
            // Diagnostic — earlier reports of "[fileWatcher] no
            // pluginAuthToken" trace back to here. Surface the actual
            // shape we got so we can tell whether the backend stopped
            // returning the field, returned it under a different
            // name, or sent something non-string.
            this.log.appendLine(
              `[pairing] WARN no pluginAuthToken on status response — rawToken=${typeof rawToken} keys=${Object.keys(data).join(',')}`,
            );
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
    SettingsService.getInstance().setPluginAuthToken(null);
  }

  /**
   * Re-attach a saved paired session without requiring a fresh QR code.
   *
   * This deliberately avoids CommandRelayService.postJson(): that helper adds
   * the cached X-Plugin-Auth-Token to every request, and a stale token can make
   * /api/pairing/reconnect return 401 before it has a chance to mint the fresh
   * token we need. The reconnect endpoint trusts the sessionId+pluginId tuple
   * plus the poll secret, matching the CLI boot path.
   */
  async reconnectSession(
    sessionId: string,
    cached?: Partial<RecentSession>,
  ): Promise<boolean> {
    const settings = SettingsService.getInstance();
    const pluginId = settings.ensurePluginId();

    try {
      const result = await this.postJson(
        `${settings.apiBaseUrl}/api/pairing/reconnect`,
        { pluginId, sessionId },
        { 'X-Plugin-Poll-Secret': settings.ensurePollSecret() },
      );

      const success = (result as Record<string, unknown> | null)?.success === true;
      if (!success) return false;

      const data = (result as Record<string, unknown>).data as Record<string, unknown> | undefined;
      const rawToken = data?.pluginAuthToken;
      if (typeof rawToken === 'string' && rawToken.length > 0) {
        settings.setPluginAuthToken(rawToken);
        this.log.appendLine(`[reconnect] Stored pluginAuthToken (${rawToken.length} chars)`);
        CommandRelayService.getInstance().resetAuthFailureGate();
      } else {
        this.log.appendLine(
          `[reconnect] WARN no pluginAuthToken on reconnect response — rawToken=${typeof rawToken}`,
        );
      }

      const userObj = data?.user as Record<string, unknown> | undefined;
      this.onReconnected(sessionId, {
        name: (userObj?.name as string) || cached?.userName || '',
        email: (userObj?.email as string) || cached?.userEmail || '',
        plan: (userObj?.plan as string) || cached?.userPlan || 'FREE',
        currentPeriodEnd: userObj?.currentPeriodEnd as string | undefined,
      });
      return true;
    } catch (e) {
      this.log.appendLine(`Reconnect error: ${e}`);
      return false;
    }
  }

  onReconnected(sessionId: string, user: PairedUserInfo): void {
    this.currentSessionId = sessionId;
    this.pairedUser = user;
    this.saveCurrentSession();
    this.listeners.forEach((l) => l.onPaired(sessionId));
  }

  private async getJson(
    url: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const transport = urlObj.protocol === 'https:' ? https : http;
      const req = transport.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          ...(extraHeaders ? { headers: extraHeaders } : {}),
          timeout: 10000,
        },
        (res: http.IncomingMessage) => {
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

  private async postJson(
    url: string,
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown> | null> {
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
            'X-Codeam-Protocol-Version': PROTOCOL_VERSION,
            ...(extraHeaders ?? {}),
          },
          timeout: 10000,
        },
        (res: http.IncomingMessage) => {
          let responseBody = '';
          res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
          res.on('end', () => {
            try { resolve(JSON.parse(responseBody)); } catch { resolve(null); }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(data);
      req.end();
    });
  }
}

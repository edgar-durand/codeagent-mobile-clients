import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { DEFAULT_API_BASE_URL } from '@codeagent/shared';

export interface RecentSession {
  sessionId: string;
  userName: string;
  userEmail: string;
  userPlan: string;
  connectedAt: number;
}

export class SettingsService {
  private static instance: SettingsService;
  private context: vscode.ExtensionContext;

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  static initialize(context: vscode.ExtensionContext): SettingsService {
    SettingsService.instance = new SettingsService(context);
    return SettingsService.instance;
  }

  static getInstance(): SettingsService {
    if (!SettingsService.instance) {
      throw new Error('SettingsService not initialized');
    }
    return SettingsService.instance;
  }

  get apiBaseUrl(): string {
    // SYNC WITH packages/shared/src/api-url.ts and the `default` value in
    // apps/vsc-plugin/package.json (contributes.configuration.…apiBaseUrl).
    return this.getConfig<string>('apiBaseUrl', DEFAULT_API_BASE_URL);
  }

  get autoConnect(): boolean {
    return this.getConfig<boolean>('autoConnect', true);
  }

  get showNotifications(): boolean {
    return this.getConfig<boolean>('showNotifications', true);
  }

  get heartbeatIntervalMs(): number {
    return this.getConfig<number>('heartbeatIntervalMs', 30000);
  }

  ensurePluginId(): string {
    let pluginId = this.context.globalState.get<string>('pluginId');
    if (!pluginId) {
      pluginId = generateUUID();
      this.context.globalState.update('pluginId', pluginId);
    }
    return pluginId;
  }

  /**
   * Per-pairing token returned by the backend at `/api/pairing/status`
   * once `paired: true`. Replayed as `X-Plugin-Auth-Token` on every
   * authed POST/GET so the server can authenticate this plugin
   * after the legacy fallback expires (2026-05-25).
   */
  getPluginAuthToken(): string | null {
    return this.context.globalState.get<string>('pluginAuthToken') ?? null;
  }

  setPluginAuthToken(token: string | null): void {
    if (token) {
      this.context.globalState.update('pluginAuthToken', token);
    } else {
      this.context.globalState.update('pluginAuthToken', undefined);
    }
  }

  getRecentSessions(): RecentSession[] {
    return this.context.globalState.get<RecentSession[]>('recentSessions') || [];
  }

  addRecentSession(session: RecentSession): void {
    let sessions = this.getRecentSessions();
    sessions = sessions.filter((s) => s.sessionId !== session.sessionId);
    sessions.unshift(session);
    if (sessions.length > 10) {
      sessions = sessions.slice(0, 10);
    }
    this.context.globalState.update('recentSessions', sessions);
  }

  removeRecentSession(sessionId: string): void {
    let sessions = this.getRecentSessions();
    sessions = sessions.filter((s) => s.sessionId !== sessionId);
    this.context.globalState.update('recentSessions', sessions);
  }

  private getConfig<T>(key: string, defaultValue: T): T {
    const config = vscode.workspace.getConfiguration('codeagent-mobile');
    return config.get<T>(key, defaultValue);
  }
}

function generateUUID(): string {
  return crypto.randomUUID();
}

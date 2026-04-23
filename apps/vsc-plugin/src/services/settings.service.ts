import * as vscode from 'vscode';
import * as crypto from 'crypto';

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
    return this.getConfig<string>('apiBaseUrl', 'https://codeagent-mobile-api.vercel.app');
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

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

const AUTH_TOKEN_KEY = 'pluginAuthToken';

interface ConfigSnapshot {
  apiBaseUrl: string;
  autoConnect: boolean;
  showNotifications: boolean;
  heartbeatIntervalMs: number;
  telemetryEnabled: boolean;
}

export class SettingsService {
  private static instance: SettingsService;
  private context: vscode.ExtensionContext;
  // In-memory cache loaded from SecretStorage during initialize so the
  // synchronous getPluginAuthToken() can answer without awaiting.
  private cachedAuthToken: string | null = null;

  // Resolved-config snapshot. Refreshed on every
  // workspace.onDidChangeConfiguration event for our section so the
  // hot read path (apiBaseUrl on every postJson / SSE reconnect)
  // doesn't pay a workspace.getConfiguration call each time.
  private cachedConfig: ConfigSnapshot;
  // Apply-base-url-changed callbacks. CommandRelayService registers
  // one so a mid-session apiBaseUrl flip force-reconnects SSE
  // instead of waiting for the next ~30s reconnect window.
  private apiBaseUrlListeners: Array<(prev: string, next: string) => void> = [];

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.cachedConfig = this.readConfigSnapshot();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('codeagent-mobile')) return;
        const prev = this.cachedConfig;
        this.cachedConfig = this.readConfigSnapshot();
        if (prev.apiBaseUrl !== this.cachedConfig.apiBaseUrl) {
          for (const fn of this.apiBaseUrlListeners) {
            try { fn(prev.apiBaseUrl, this.cachedConfig.apiBaseUrl); } catch { /* ignore */ }
          }
        }
      }),
    );
  }

  static async initialize(context: vscode.ExtensionContext): Promise<SettingsService> {
    const instance = new SettingsService(context);
    SettingsService.instance = instance;
    await instance.loadAuthTokenFromSecureStorage();
    return instance;
  }

  static getInstance(): SettingsService {
    if (!SettingsService.instance) {
      throw new Error('SettingsService not initialized');
    }
    return SettingsService.instance;
  }

  /**
   * Loads pluginAuthToken from SecretStorage and migrates any plaintext
   * value still sitting in globalState (older installs). The cache
   * field is the only sync read path for the rest of the codebase.
   */
  private async loadAuthTokenFromSecureStorage(): Promise<void> {
    const legacy = this.context.globalState.get<string>(AUTH_TOKEN_KEY);
    if (legacy) {
      await this.context.secrets.store(AUTH_TOKEN_KEY, legacy);
      await this.context.globalState.update(AUTH_TOKEN_KEY, undefined);
      this.cachedAuthToken = legacy;
      return;
    }
    const stored = await this.context.secrets.get(AUTH_TOKEN_KEY);
    this.cachedAuthToken = stored ?? null;
  }

  get apiBaseUrl(): string {
    // SYNC WITH packages/shared/src/api-url.ts and the `default` value in
    // apps/vsc-plugin/package.json (contributes.configuration.…apiBaseUrl).
    return this.cachedConfig.apiBaseUrl;
  }

  get autoConnect(): boolean {
    return this.cachedConfig.autoConnect;
  }

  get showNotifications(): boolean {
    return this.cachedConfig.showNotifications;
  }

  get heartbeatIntervalMs(): number {
    return this.cachedConfig.heartbeatIntervalMs;
  }

  /**
   * Register a callback fired when the user changes the apiBaseUrl
   * setting mid-session. CommandRelayService uses this to
   * tear-down + reconnect the SSE stream against the new host
   * immediately instead of waiting for the next ~30s reconnect
   * cycle.
   */
  onApiBaseUrlChanged(listener: (prev: string, next: string) => void): void {
    this.apiBaseUrlListeners.push(listener);
  }

  private readConfigSnapshot(): ConfigSnapshot {
    const cfg = vscode.workspace.getConfiguration('codeagent-mobile');
    return {
      apiBaseUrl: cfg.get<string>('apiBaseUrl', DEFAULT_API_BASE_URL),
      autoConnect: cfg.get<boolean>('autoConnect', true),
      showNotifications: cfg.get<boolean>('showNotifications', true),
      heartbeatIntervalMs: cfg.get<number>('heartbeatIntervalMs', 30000),
      telemetryEnabled: cfg.get<boolean>('telemetryEnabled', true),
    };
  }

  /**
   * Returns a pluginId distinct per (installation + first-workspace).
   * Two VS Code windows on different projects get distinct ids so the
   * backend's SSE dispatch routes each command to the right window.
   *
   * Migration: the v1 layout used a single `pluginId` globalState
   * entry shared across every window. On first call we adopt that
   * value as the current workspace's id (preserves existing pairings)
   * + leave the legacy entry in place for any caller that still
   * reads it directly. Subsequent workspaces generate fresh ids.
   */
  ensurePluginId(): string {
    const key = this.workspaceKey();
    const map = this.context.globalState.get<Record<string, string>>('pluginIdsByWorkspace') ?? {};
    const cached = map[key];
    if (cached) return cached;
    const legacy = this.context.globalState.get<string>('pluginId');
    const pluginId = legacy ?? generateUUID();
    map[key] = pluginId;
    this.context.globalState.update('pluginIdsByWorkspace', map);
    if (!legacy) {
      // First-time install: also seed the legacy slot so any future
      // call before the workspace map is read still returns the same id.
      this.context.globalState.update('pluginId', pluginId);
    }
    return pluginId;
  }

  /**
   * Stable per-workspace identifier. Hashes the first workspace
   * folder's fsPath; when no workspace is open we fall back to a
   * "no-workspace" bucket so the id is at least deterministic for
   * panel-only-without-folder users.
   */
  private workspaceKey(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return 'no-workspace';
    return crypto.createHash('sha256').update(folder).digest('hex').slice(0, 16);
  }

  /**
   * Per-pairing token returned by the backend at `/api/pairing/status`
   * once `paired: true`. Replayed as `X-Plugin-Auth-Token` on every
   * authed POST/GET so the server can authenticate this plugin
   * after the legacy fallback expires (2026-05-25). Persisted in
   * VS Code's SecretStorage (OS keychain on macOS/Win, libsecret on
   * Linux); the in-memory cache lets callers stay synchronous.
   */
  getPluginAuthToken(): string | null {
    return this.cachedAuthToken;
  }

  setPluginAuthToken(token: string | null): void {
    this.cachedAuthToken = token;
    if (token) {
      void this.context.secrets.store(AUTH_TOKEN_KEY, token);
    } else {
      void this.context.secrets.delete(AUTH_TOKEN_KEY);
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

}

function generateUUID(): string {
  return crypto.randomUUID();
}

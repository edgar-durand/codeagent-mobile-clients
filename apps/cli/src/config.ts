import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SavedSession {
  id: string;
  pluginId?: string; // unique per pairing (undefined on pre-existing sessions → falls back to global)
  userName: string;
  userEmail: string;
  plan: string;
  pairedAt: number;
}

export interface CliConfig {
  pluginId: string;
  activeSessionId: string | null;
  sessions: SavedSession[];
}

const EMPTY_CONFIG = (): CliConfig => ({
  pluginId: crypto.randomUUID(),
  activeSessionId: null,
  sessions: [],
});

export function makeConfig(baseDir?: string) {
  const dir = path.join(baseDir ?? os.homedir(), '.codeam');
  const file = path.join(dir, 'config.json');

  function load(): CliConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return {
        pluginId: typeof raw.pluginId === 'string' ? raw.pluginId : crypto.randomUUID(),
        activeSessionId: typeof raw.activeSessionId === 'string' ? raw.activeSessionId : null,
        sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      };
    } catch {
      return EMPTY_CONFIG();
    }
  }

  function save(c: CliConfig): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(c, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  function getConfig(): CliConfig {
    return load();
  }

  function ensurePluginId(): string {
    const c = load();
    save(c);
    return c.pluginId;
  }

  function addSession(session: SavedSession): void {
    const c = load();
    c.sessions = c.sessions.filter(s => s.id !== session.id);
    c.sessions.unshift(session);
    // Always switch active to the newly paired session so start() immediately
    // after pair() uses the correct pluginId (not a previous session's).
    c.activeSessionId = session.id;
    save(c);
  }

  function removeSession(sessionId: string): void {
    const c = load();
    c.sessions = c.sessions.filter(s => s.id !== sessionId);
    if (c.activeSessionId === sessionId) {
      c.activeSessionId = c.sessions[0]?.id ?? null;
    }
    save(c);
  }

  function setActiveSession(sessionId: string): void {
    const c = load();
    c.activeSessionId = sessionId;
    save(c);
  }

  function getActiveSession(): SavedSession | null {
    const c = load();
    if (!c.activeSessionId) return null;
    const session = c.sessions.find(s => s.id === c.activeSessionId) ?? null;
    if (!session) {
      c.activeSessionId = null;
      save(c);
    }
    return session;
  }

  function clearAll(): void {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }

  return { getConfig, ensurePluginId, addSession, removeSession, setActiveSession, getActiveSession, clearAll };
}

// Default instance — uses ~/.codeam/config.json
const _default = makeConfig();
export const { getConfig, ensurePluginId, addSession, removeSession, setActiveSession, getActiveSession, clearAll } =
  _default;

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AgentId } from '@codeagent/shared';

export interface SavedSession {
  id: string;
  pluginId?: string; // unique per pairing (undefined on pre-existing sessions → falls back to global)
  userName: string;
  userEmail: string;
  plan: string;
  pairedAt: number;
  /**
   * Plugin auth token returned by /api/pairing/status. Persisted so subsequent
   * POSTs to /api/commands/output can replay it as `X-Plugin-Auth-Token`.
   * Optional — sessions paired before this field existed (or with older
   * backends that did not yet emit the token) keep working via the rolling
   * legacy fallback on the server (sunset 2026-05-25).
   */
  pluginAuthToken?: string;
  agent: AgentId;
}

export interface CliConfig {
  pluginId: string;
  activeSessionId: string | null;
  sessions: SavedSession[];
  preferredAgent?: AgentId;
}

const EMPTY_CONFIG = (): CliConfig => ({
  pluginId: crypto.randomUUID(),
  activeSessionId: null,
  sessions: [],
});

/**
 * Migration: Phase 1 support for multi-agent. Pre-existing sessions without
 * an `agent` field default to 'claude' when loaded.
 */
function migrateSession(s: SavedSession): SavedSession {
  return { ...s, agent: s.agent ?? 'claude' };
}

export function makeConfig(baseDir?: string) {
  const dir = path.join(baseDir ?? os.homedir(), '.codeam');
  const file = path.join(dir, 'config.json');

  function load(): CliConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return {
        pluginId: typeof raw.pluginId === 'string' ? raw.pluginId : crypto.randomUUID(),
        activeSessionId: typeof raw.activeSessionId === 'string' ? raw.activeSessionId : null,
        sessions: Array.isArray(raw.sessions) ? raw.sessions.map(migrateSession) : [],
        preferredAgent: typeof raw.preferredAgent === 'string' ? raw.preferredAgent : undefined,
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

  /**
   * Returns the most-recently-paired session for the given agent, regardless
   * of which session is globally "active". Used by `codeam <agent>` so a user
   * explicitly requesting an agent always lands on a session paired to that
   * agent — even when another terminal has just paired a different agent and
   * promoted its session to globally active.
   *
   * Does NOT mutate `activeSessionId` — keeping that field's semantics as
   * "last paired" rather than "last used".
   */
  function getActiveSessionForAgent(agent: AgentId): SavedSession | null {
    const c = load();
    const matches = c.sessions.filter(s => s.agent === agent);
    if (matches.length === 0) return null;
    // sessions[] is maintained newest-first by addSession (unshift), but be
    // defensive in case future edits change that — sort by pairedAt desc.
    matches.sort((a, b) => b.pairedAt - a.pairedAt);
    return matches[0];
  }

  function clearAll(): void {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }

  function saveCliConfig(c: CliConfig): void {
    save(c);
  }

  function loadCliConfig(): CliConfig {
    return load();
  }

  return { getConfig, ensurePluginId, addSession, removeSession, setActiveSession, getActiveSession, getActiveSessionForAgent, clearAll, saveCliConfig, loadCliConfig };
}

// Default instance — uses ~/.codeam/config.json
const _default = makeConfig();
export const { getConfig, ensurePluginId, addSession, removeSession, setActiveSession, getActiveSession, getActiveSessionForAgent, clearAll, saveCliConfig, loadCliConfig } =
  _default;

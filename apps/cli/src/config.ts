import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AgentId } from '@codeam/shared';
import { rmIfExistsQuiet } from './lib/quiet';

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
  /**
   * SEC: high-entropy proof-of-possession secret generated locally at
   * pairing time (never sent to the server in the clear). Sent as
   * `sha256(pollSecret)` at enrollment and replayed raw as the
   * `X-Plugin-Poll-Secret` header on `/api/pairing/status` +
   * `/api/pairing/reconnect`, so the backend returns the auth token +
   * owner PII only to the device that initiated pairing — not to anyone
   * who learns the (non-secret) pluginId. Optional: sessions paired
   * before this existed have none and use the backend's legacy
   * pluginId-only path until they re-pair.
   */
  pollSecret?: string;
  agent: AgentId;
  /**
   * Set on demand when the user picks "Disable 1M context and continue" after
   * Anthropic's 1M-context usage-credits 429 (claude Code v2.1.x sends the
   * `context-1m` beta even on accounts without 1M credits). Read at agent
   * spawn to inject `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` so the gate never
   * recurs for this session, even across a codeam restart.
   */
  disable1mContext?: boolean;
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
    // Atomic write: stage to a sibling temp file then rename. POSIX
    // and NTFS both guarantee rename atomicity within a single
    // filesystem, so any reader sees either the previous file or the
    // new file — never a half-written one. Without this, a SIGKILL
    // / power loss / laptop sleep mid-`writeFileSync` truncates
    // config.json and the next CLI launch silently returns
    // EMPTY_CONFIG → user loses every paired session and has to
    // re-pair every device.
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(c, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmp, file);
    } catch (err) {
      // Best-effort cleanup of the orphaned temp file. If we can't
      // remove it (rare — usually means EACCES on the dir), leave it;
      // a subsequent successful save() will overwrite-via-rename and
      // the next clearAll() / boot picks it up.
      rmIfExistsQuiet(tmp);
      throw err;
    }
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

  /**
   * On-demand toggle of the per-session 1M-context disable flag. Looked up by
   * pluginId (the relay's stable session key). No-op when the session isn't
   * found (it may have been removed between the failed turn and the user's tap).
   */
  function setDisable1mContext(pluginId: string, value: boolean): void {
    const c = load();
    const s = c.sessions.find(x => x.pluginId === pluginId);
    if (!s) return;
    s.disable1mContext = value;
    save(c);
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

  return { getConfig, ensurePluginId, addSession, removeSession, setActiveSession, getActiveSession, getActiveSessionForAgent, setDisable1mContext, clearAll, saveCliConfig, loadCliConfig };
}

/**
 * Keys the backend bootstrap writes into `~/.codeam/codespace-env.json`.
 * Contract with the backend — these names are verbatim and must not drift.
 */
const CODESPACE_ENV_KEYS = [
  'PREVIEW_TUNNEL_TOKEN',
  'PREVIEW_TUNNEL_HOSTNAME',
  'HEADROOM_ENABLED',
  'HEADROOM_AGENT',
  'HEADROOM_SAVINGS_INGEST_URL',
] as const;

/**
 * Load the codespace env file (`~/.codeam/codespace-env.json`) into
 * `process.env` at process startup.
 *
 * WHY: the codespace serving daemon is spawned via `setsid` with NO shell rc
 * sourced, so env vars exported by the backend bootstrap
 * (PREVIEW_TUNNEL_TOKEN/HOSTNAME, HEADROOM_*) never reach the daemon's
 * `process.env`. Symptoms: preview falls back to a quick trycloudflare tunnel
 * instead of the NAMED tunnel (which fails to resolve → -1003), and the
 * Headroom savings reporter never starts (admin dashboard empty). The backend
 * now also drops those same vars into a JSON file; reading it here restores
 * them however the daemon was spawned.
 *
 * Contract: the file is a JSON object with any of the {@link CODESPACE_ENV_KEYS}
 * present as string values. Only those keys are accepted; unknown keys and
 * non-string values are ignored. A real env var ALWAYS wins over the file
 * (we set a key only when it is currently `undefined`), so an explicit export
 * is never clobbered.
 *
 * Best-effort and side-effect-free on local / self-hosted: a missing file,
 * unreadable file, or malformed JSON is a silent no-op (those environments
 * never write this file, so they keep their existing behaviour unchanged).
 */
export function loadCodespaceEnv(): void {
  try {
    const file = path.join(os.homedir(), '.codeam', 'codespace-env.json');
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    for (const key of CODESPACE_ENV_KEYS) {
      const value = raw[key];
      if (typeof value === 'string' && value.length > 0 && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    /* best-effort: missing file / parse error / unreadable → no-op */
  }
}

// Default instance — uses ~/.codeam/config.json
const _default = makeConfig();
export const { getConfig, ensurePluginId, addSession, removeSession, setActiveSession, getActiveSession, getActiveSessionForAgent, setDisable1mContext, clearAll, saveCliConfig, loadCliConfig } =
  _default;

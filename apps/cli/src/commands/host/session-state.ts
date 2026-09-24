import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SavedSession } from '../../config';

/**
 * The host-agent's record of WHICH session children were live — the state a
 * restart must bring back (codeagent-v07a).
 *
 * WHY: after `systemctl restart codeam-host-agent` only the most recent
 * session came back (live, 2026-09-23). The boot resume read
 * `getActiveSession()` — the CLI config's single "last paired" pointer — so
 * with two active sessions on one box the older one was dropped silently: no
 * child, no `ended` event, a dead card in the app. The supervisor is the only
 * party that knows the live set, and it kept it in memory only.
 *
 * This file (`~/.codeam/host-agent-sessions.json`) mirrors the supervisor's
 * children map on every add/remove. It is NOT rewritten on a graceful
 * `stop()` — the children it lists are exactly the ones "active at shutdown"
 * that the next boot resumes. A session the app deleted exits its child →
 * removed here → not resumed. Best-effort I/O: a write failure degrades to the
 * pre-existing single-session fallback, never to a crash.
 */
export interface PersistedSessionChild {
  /** Deploy id the child is keyed on (what every upward signal carries). */
  deployId: string;
  /** Workspace the child ran in — the key back to its `SavedSession`. */
  cwd: string;
  /** Agent kind, for the heartbeat label + logs. */
  agent: string;
  /** Epoch ms of the spawn — newest-first ordering under the resume bound. */
  startedAt: number;
}

export interface SessionChildStore {
  load(): PersistedSessionChild[];
  save(list: PersistedSessionChild[]): void;
  clear(): void;
}

/** `CODEAM_HOST_SESSION_STATE_FILE` overrides the location (tests, odd layouts). */
export function hostSessionStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEAM_HOST_SESSION_STATE_FILE;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), '.codeam', 'host-agent-sessions.json');
}

function isRecord(v: unknown): v is PersistedSessionChild {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.deployId === 'string' &&
    o.deployId.length > 0 &&
    typeof o.cwd === 'string' &&
    o.cwd.length > 0 &&
    typeof o.agent === 'string' &&
    typeof o.startedAt === 'number' &&
    Number.isFinite(o.startedAt)
  );
}

/** File-backed store: atomic write (tmp + rename), owner-only mode, never throws. */
export function fileSessionChildStore(file: string = hostSessionStatePath()): SessionChildStore {
  return {
    load(): PersistedSessionChild[] {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions?: unknown };
        return Array.isArray(raw?.sessions) ? raw.sessions.filter(isRecord) : [];
      } catch {
        return [];
      }
    },
    save(list: PersistedSessionChild[]): void {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: list }, null, 2), {
          mode: 0o600,
        });
        fs.renameSync(tmp, file);
      } catch {
        /* best-effort — the boot falls back to the single-session resume */
      }
    },
    clear(): void {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * How many sessions a boot resumes at once. Each session is one agent
 * process (the memory hog), so the bound is deliberate; sessions beyond it
 * are ENDED explicitly so the app shows that instead of a dead card.
 * `CODEAM_HOST_MAX_RESUME_SESSIONS` overrides (clamped 1..10).
 */
export const DEFAULT_MAX_RESUME_SESSIONS = 3;
export const MAX_RESUME_SESSIONS_CEILING = 10;

export function resolveMaxResumeSessions(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CODEAM_HOST_MAX_RESUME_SESSIONS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_RESUME_SESSIONS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_RESUME_SESSIONS;
  return Math.min(n, MAX_RESUME_SESSIONS_CEILING);
}

/**
 * Split the persisted set into the sessions to resume (newest `max` by
 * `startedAt`) and the ones to end. Deduped by deployId (last write wins).
 */
export function planSessionResume(
  records: PersistedSessionChild[],
  max: number,
): { resume: PersistedSessionChild[]; dropped: PersistedSessionChild[] } {
  const byId = new Map<string, PersistedSessionChild>();
  for (const r of records) byId.set(r.deployId, r);
  const ordered = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
  const bound = Math.max(0, Math.floor(max));
  return { resume: ordered.slice(0, bound), dropped: ordered.slice(bound) };
}

/**
 * The `SavedSession` a persisted child maps back to: same workspace, carrying
 * the reconnect material (pluginId + pollSecret + agent), newest pairing
 * first. `null` when the app deleted it (`session_terminated` removes it from
 * the config) — that child is not resumed.
 */
export function pickSavedSessionForWorkspace(
  sessions: SavedSession[],
  cwd: string,
): SavedSession | null {
  const target = path.resolve(cwd);
  const matches = sessions.filter(
    (s) =>
      !!s.cwd &&
      path.resolve(s.cwd) === target &&
      !!s.pluginId &&
      !!s.pollSecret &&
      !!s.agent,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.pairedAt - a.pairedAt);
  return matches[0];
}

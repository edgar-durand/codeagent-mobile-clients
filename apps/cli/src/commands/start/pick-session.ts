import type { SavedSession } from '../../config';

/**
 * Resolve `CODEAM_RESUME_SESSION_ID` — the session a host-agent boot resume
 * pins THIS `codeam` child to (codeagent-v07a). Pure so it is unit-tested
 * without booting `start()`.
 *
 *   - `none`    — no pin; the caller falls back to its usual selection.
 *   - `found`   — the pinned session is still paired; use exactly it.
 *   - `missing` — pinned but no longer in the config (deleted from the app
 *                 between shutdown and boot). The caller exits 0 WITHOUT
 *                 falling back: a fallback would re-drive the last-paired
 *                 session that another resume child already owns.
 */
export type PinnedSessionPick =
  | { kind: 'none' }
  | { kind: 'found'; session: SavedSession }
  | { kind: 'missing'; id: string };

export function pickPinnedSession(
  pinnedId: string | undefined,
  listSessions: () => SavedSession[],
): PinnedSessionPick {
  const id = pinnedId?.trim();
  if (!id) return { kind: 'none' };
  let sessions: SavedSession[] = [];
  try {
    sessions = listSessions();
  } catch {
    sessions = [];
  }
  const session = sessions.find((s) => s.id === id);
  return session ? { kind: 'found', session } : { kind: 'missing', id };
}

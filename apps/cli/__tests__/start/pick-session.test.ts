import { describe, expect, it } from 'vitest';
import { pickPinnedSession } from '../../src/commands/start/pick-session';
import type { SavedSession } from '../../src/config';

// codeagent-v07a: a host-agent boot resume spawns one bare `codeam` per live
// session and pins each to ITS session with CODEAM_RESUME_SESSION_ID. Without
// the pin every child resolved the same last-paired session and only one
// survived the per-session daemon lock.
const s = (id: string): SavedSession => ({
  id,
  userName: 'u',
  userEmail: 'e',
  plan: 'pro',
  pairedAt: 0,
  agent: 'claude',
  pluginId: `plug-${id}`,
  pollSecret: 'x',
});

describe('pickPinnedSession', () => {
  it('is `none` without a pin (blank included) so the caller keeps its usual selection', () => {
    expect(pickPinnedSession(undefined, () => [s('a')])).toEqual({ kind: 'none' });
    expect(pickPinnedSession('  ', () => [s('a')])).toEqual({ kind: 'none' });
  });

  it('returns exactly the pinned session — not the newest / active one', () => {
    const pick = pickPinnedSession('older', () => [s('newest'), s('older')]);
    expect(pick.kind).toBe('found');
    if (pick.kind === 'found') expect(pick.session.id).toBe('older');
  });

  it('is `missing` when the pinned session was deleted from the app (no silent fallback)', () => {
    expect(pickPinnedSession('gone', () => [s('a')])).toEqual({ kind: 'missing', id: 'gone' });
  });

  it('treats a config read failure as `missing`, never throws', () => {
    expect(
      pickPinnedSession('a', () => {
        throw new Error('EACCES');
      }),
    ).toEqual({ kind: 'missing', id: 'a' });
  });
});

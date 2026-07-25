import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * STATIC "use bd" instruction, written to the global `~/.claude/CLAUDE.md` so the
 * agent knows to use beads the instant it spawns — WITHOUT waiting for beads to
 * finish provisioning.
 *
 * Why this exists: beads provisioning is ~20s of sequential Dolt startup
 * (bd init → shared server → project DB). It used to GATE the agent spawn, because
 * bd's own SessionStart hook (`bd prime`) only teaches the agent to use bd once the
 * DB is reachable — a `bd prime` against a down server returns EMPTY (verified),
 * so an un-gated agent would "never learn to use bd" and write files instead of
 * `bd remember` (the v2.39.6 bug). This hint is the DB-INDEPENDENT half of the
 * contract: the agent learns to use bd immediately from this file; the dynamic
 * MEMORIES arrive when `bd prime` runs against a ready server moments later.
 *
 * A RUNTIME write (not baked into the box image): the fleet box mounts a volume
 * over /home/box that would shadow anything baked there, so this must be written
 * live, early in `start()`, before the agent spawns.
 *
 * Idempotent (marker-guarded), append-not-clobber (preserves any existing global
 * CLAUDE.md), and strictly best-effort (never throws — must not block the agent).
 */
const BEADS_HINT_MARKER = '<!-- codeam:beads-workflow -->';

const BEADS_HINT = `${BEADS_HINT_MARKER}
# Beads (bd) — task tracking + persistent memory (ALWAYS use it)

This environment uses **bd (beads)** for issue/task tracking and persistent memory.

- Use \`bd\` for ALL task tracking — do NOT use TodoWrite or markdown TODO lists.
- Run \`bd prime\` for the full workflow context + project memories. On a fresh
  session beads may still be provisioning for a few seconds — if \`bd prime\` comes
  back empty, retry it shortly; it works once the shared server is up.
- \`bd ready\` (available work) · \`bd show <id>\` · \`bd update <id> --claim\` · \`bd close <id>\`.
- Use \`bd remember "..."\` for persistent knowledge — do NOT use MEMORY.md files.
${BEADS_HINT_MARKER}`;

export function ensureBeadsWorkflowHint(homeDir: string = os.homedir()): void {
  try {
    const file = path.join(homeDir, '.claude', 'CLAUDE.md');
    let existing = '';
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {
      /* new file — fine */
    }
    if (existing.includes(BEADS_HINT_MARKER)) return; // already present (idempotent)
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next = existing.trim()
      ? `${existing.trimEnd()}\n\n${BEADS_HINT}\n`
      : `${BEADS_HINT}\n`;
    fs.writeFileSync(file, next);
  } catch {
    /* best-effort — a failure here must never block or fail the agent spawn */
  }
}

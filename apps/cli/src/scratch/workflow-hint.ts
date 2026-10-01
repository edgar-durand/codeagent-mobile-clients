import fs from 'node:fs';
import path from 'node:path';
import { claudeMemoryFile } from '../agents/claude-memory-file';

/**
 * STATIC "this is a from-scratch project" instruction for the agent, written
 * to the global `~/.claude/CLAUDE.md` before the spawn — same mechanism and
 * idempotency as the beads hint. The `suggest_save_project` tool description
 * alone was not enough: in the live E2E the agent built and previewed a page
 * and never offered to save it (2026-09-29). The CLI now fires the offer
 * itself on the first `preview_ready`; this block keeps the agent from
 * pushing / creating repos on its own and tells it saving is the user's
 * choice in the app.
 */
const SCRATCH_HINT_MARKER = '<!-- codeam:scratch-workflow -->';

const SCRATCH_HINT = `${SCRATCH_HINT_MARKER}
# From-scratch projects (CodeAgent Box)

When the working directory is a project started from scratch (no git remote,
a \`.git/codeam-scratch\` marker):

- Build something small, visible and working first. As soon as it can be
  seen, start it with the \`codeagent_preview\` \`start_preview\` tool and tell the
  user the preview is open.
- If the user asks what you can do or for ideas, list them in a few short
  lines and build the first one in the same turn (unless they ask you to
  wait), so they see something running right away.
- Saving is the user's choice in the app (Save to GitHub / GitLab, or a ZIP).
  Never push, create repositories or ask for git credentials yourself. Once the
  user has seen something working, call \`suggest_save_project\` ONCE if the
  app has not offered to save yet.
${SCRATCH_HINT_MARKER}`;

export function ensureScratchWorkflowHint(
  homeDir?: string,
  file: string = claudeMemoryFile(homeDir),
): void {
  try {
    let existing = '';
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {
      /* new file — fine */
    }
    if (existing.includes(SCRATCH_HINT)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const open = existing.indexOf(SCRATCH_HINT_MARKER);
    const close =
      open === -1 ? -1 : existing.indexOf(SCRATCH_HINT_MARKER, open + SCRATCH_HINT_MARKER.length);
    const next =
      open !== -1 && close !== -1
        ? existing.slice(0, open) +
          SCRATCH_HINT +
          existing.slice(close + SCRATCH_HINT_MARKER.length)
        : existing.trim()
          ? `${existing.trimEnd()}\n\n${SCRATCH_HINT}\n`
          : `${SCRATCH_HINT}\n`;
    fs.writeFileSync(file, next);
  } catch {
    /* best-effort — must never block the agent spawn */
  }
}

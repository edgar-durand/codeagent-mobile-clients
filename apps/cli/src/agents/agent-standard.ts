import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AGENT_STANDARD_MARKER, AGENT_STANDARD_BLOCK, AGENT_STANDARD_TEXT } from '@codeam/shared';
import { isLocalSession } from '../baton/gate';
import type { PromptBlock } from './acp/buildAcpPromptBlocks';

/**
 * Delivery of the always-on Agent Standard (single source: `@codeam/shared`),
 * split on the Claude rail exactly like the rest of the skills plumbing:
 *
 *  - **Claude** → {@link ensureAgentStandard} appends the standard to the global
 *    `~/.claude/CLAUDE.md` at spawn (marker-guarded, idempotent), so it's always
 *    in context — mirrors `ensureBeadsWorkflowHint`.
 *  - **Every other ACP agent** (codex/gemini/cursor/opencode…) → they don't read
 *    `~/.claude/CLAUDE.md`, and ACP has no system-prompt channel, so
 *    {@link maybePrefaceAgentStandard} prepends the standard as a one-time text
 *    block on the FIRST turn of a new conversation (a per-session marker guards
 *    against re-prefacing on resume, which would land mid-conversation).
 *
 * Both are gated to MANAGED deploys (`!isLocalSession()`) — a user's own machine
 * keeps its own `~/.claude/CLAUDE.md` untouched. Both are strictly best-effort:
 * a failure here must never block or fail the agent.
 */

// ─── Claude rail: append to ~/.claude/CLAUDE.md ───────────────────────────────

export function ensureAgentStandard(homeDir: string = os.homedir()): void {
  try {
    const file = path.join(homeDir, '.claude', 'CLAUDE.md');
    let existing = '';
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {
      /* new file — fine */
    }
    if (existing.includes(AGENT_STANDARD_MARKER)) return; // already present (idempotent)
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next = existing.trim()
      ? `${existing.trimEnd()}\n\n${AGENT_STANDARD_BLOCK}\n`
      : `${AGENT_STANDARD_BLOCK}\n`;
    fs.writeFileSync(file, next);
  } catch {
    /* best-effort — must never block the agent spawn */
  }
}

// ─── Non-Claude rail: one-time prompt preface ─────────────────────────────────

/** Seam for the once-per-session marker + gate, so tests drive it without the
 *  real `~/.codeam` or process env. */
export const _agentStandardSeam = {
  isLocalSession: (): boolean => isLocalSession(),
  markerPath: (sessionId: string): string =>
    path.join(os.homedir(), '.codeam', 'agent-standard', `${sessionId}.done`),
  exists: (p: string): boolean => fs.existsSync(p),
  write: (p: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
  },
};

function isClaude(agent: string): boolean {
  return agent === 'claude' || agent === 'claude_code';
}

/**
 * Prepend the Agent Standard as the leading text block of a non-Claude ACP
 * turn, exactly once per session. Mutates `blocks` in place (caller sends them
 * to `client.prompt`) — deliberately AFTER the caller has computed the recorded
 * user prompt / terminal echo, so the standard rides the agent prompt only and
 * never shows as part of the user's message. No-op for Claude (it gets the
 * `~/.claude/CLAUDE.md` file), on local sessions, or once the marker exists.
 */
export function maybePrefaceAgentStandard(
  blocks: PromptBlock[],
  agent: string,
  sessionId: string,
  seam: typeof _agentStandardSeam = _agentStandardSeam,
): void {
  if (seam.isLocalSession()) return;
  if (isClaude(agent)) return;
  if (!sessionId) return;
  const marker = seam.markerPath(sessionId);
  try {
    if (seam.exists(marker)) return;
    seam.write(marker);
  } catch {
    // Can't read/write the marker — skip rather than risk re-prefacing on a
    // loop (a stray FS error is rarer + less intrusive than a double preface).
    return;
  }
  blocks.unshift({ type: 'text', text: AGENT_STANDARD_TEXT });
}

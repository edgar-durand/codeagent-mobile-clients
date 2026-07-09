import type { RuntimeStrategy } from '../agents/strategy';

/**
 * The baton can only engage for an agent that persists a RESUMABLE per-session
 * transcript: the LOCAL_DRIVE mirror tails it, and Take Control resumes the SAME
 * conversation over ACP. `resolveHistoryFile` is the capability marker —
 * implemented by claude, codex, cursor, and kimi; NOT by gemini/aider (no resume,
 * no tail-able file). Agents that fail this run as plain native/ACP sessions with
 * NO Take Control affordance, instead of a mirror that silently shows nothing.
 *
 * NOTE: claude/kimi share ONE transcript store across native+ACP, so the hand-off
 * is a bare `session/load`. Cursor keeps SEPARATE stores (native `~/.cursor/chats`
 * vs ACP `~/.cursor/acp-sessions`), so its strategy additionally implements the
 * `syncTranscriptFor*Resume` hooks that bridge the two at each hand-off — the
 * baton engine stays agent-agnostic; the store difference is hidden in cursor's
 * strategy.
 */
export function runtimeSupportsBaton(
  runtime: Pick<RuntimeStrategy, 'resolveHistoryFile'>,
): boolean {
  return typeof runtime.resolveHistoryFile === 'function';
}

/** True only for a LOCAL session — NOT a codespace and NOT self-hosted.
 *  Mirrors the codebase idiom `CODESPACES==='true' || CODEAM_AUTO_APPROVE==='1'`
 *  (the autonomous/headless plane) and negates it, plus the daemon-token markers. */
export function isLocalSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.CODESPACES !== 'true' &&
    env.CODEAM_AUTO_APPROVE !== '1' &&
    env.HEADROOM_ENABLED !== '1' &&
    !env.CODEAM_AUTO_TOKEN &&
    !env.CODEAM_ENROLL_TOKEN
  );
}

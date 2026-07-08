import type { RuntimeStrategy } from '../agents/strategy';

/**
 * The baton can only engage for an agent that persists a RESUMABLE per-session
 * transcript: the LOCAL_DRIVE mirror tails it, and Take Control resumes the SAME
 * conversation over ACP. `resolveHistoryFile` is the capability marker —
 * implemented by claude, codex, and cursor; NOT by gemini/aider (no resume, no
 * tail-able file). Agents that fail this run as plain native/ACP sessions with
 * NO Take Control affordance, instead of a mirror that silently shows nothing.
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

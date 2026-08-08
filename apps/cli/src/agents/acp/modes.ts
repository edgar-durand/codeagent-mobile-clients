/**
 * ACP session-mode helpers, factored into a leaf module so both the command
 * handlers (`set_mode`) and the client (`newConversation` full-auto re-assert)
 * can import without a cycle.
 */

/**
 * A native ACP mode where the AGENT ITSELF skips every permission prompt —
 * Claude `bypassPermissions`, plus the yolo/danger/full-access/skip aliases other
 * agents use. In every OTHER mode (`default`, `plan`, `acceptEdits`, …) the agent
 * asks per-tool, so the CLI must RELAY those prompts to mobile rather than
 * auto-approve.
 */
export const FULL_AUTO_MODE_RE = /bypass|yolo|danger|full.?access|skip.?perm|auto.?approve/i;

export function modeIsFullAutoApprove(modeId: string): boolean {
  return FULL_AUTO_MODE_RE.test(modeId);
}

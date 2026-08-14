/**
 * Agent-injected meta/config blocks — SYNTHETIC turns an agent writes into its
 * OWN transcript that are not real user words, distinct from Agent Squad's
 * `codeam://squad-context` leak class (see `squad-context.ts`).
 *
 * **The bug this covers (fleet-1, 2026-08-13, codex/codeam-cli 2.65.0):**
 * alongside the squad-context leak, the web dashboard showed a bubble
 * attributed to the USER containing Codex's own `<recommended_plugins>`
 * config block (a list of openai-curated-remote plugins Codex injects into
 * the rollout as part of its own bookkeeping) — never something the user
 * typed.
 *
 * Anchors are EXACT, whole-message literals — mirroring
 * `isSyntheticCodexTurn`'s existing `<environment_context>` /
 * `<turn_aborted>` gates in `agents/codex/history.ts`. A user legitimately
 * typing about "recommended_plugins" mid-sentence must NOT be caught here:
 * the check only fires when the ENTIRE (trimmed) message starts with one of
 * these tag literals, never on a substring match.
 */

/** Whole-message opening literals for known agent-injected meta/config blocks. */
const AGENT_META_BLOCK_MARKERS: readonly string[] = ['<recommended_plugins>'];

/** True when `text` (trimmed) is an agent-injected meta/config block, not
 *  user-authored conversation. Conservative — exact-anchor, never fuzzy. */
export function isAgentMetaBlock(text: string): boolean {
  const trimmed = text.trim();
  return AGENT_META_BLOCK_MARKERS.some((marker) => trimmed.startsWith(marker));
}

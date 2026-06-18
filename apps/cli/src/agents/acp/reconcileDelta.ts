/**
 * Reconcile a streaming text segment against what we've already
 * accumulated for the same chunk, transparently handling BOTH wire
 * conventions an ACP adapter can use for `agent_message_chunk`:
 *
 *   - **true deltas** — each notification carries only the NEW bytes
 *     since the last one (the convention `mappers.ts` documents and
 *     real `claude-agent-acp` against Anthropic uses). Reconciliation
 *     appends.
 *
 *   - **cumulative snapshots** — each notification carries the FULL
 *     message-so-far. This is what an OpenAI-compatible / self-hosted
 *     proxy behind `claude-agent-acp` commonly emits (e.g. the house
 *     "CodeAgent Cloud" agent pointed at a MiniMax-M3 proxy): the
 *     upstream SSE ships `message.content` snapshots rather than
 *     incremental `delta`s, and the adapter forwards each as a fresh
 *     `agent_message_chunk`. Blind `+=` accumulation then concatenates
 *     the reply with itself ("…hoy?¡Hola!…hoy?") — the intra-reply
 *     duplication bug. Reconciliation REPLACES instead.
 *
 * The decision is made by string containment, which is unambiguous for
 * the two real shapes:
 *
 *   - `incoming` starts with `existing`  → snapshot that grew → REPLACE
 *     with `incoming` (covers the very first chunk too, where
 *     `existing === ''` so every string trivially starts with it).
 *   - `existing` starts with `incoming`  → stale / shorter snapshot
 *     (re-send, retransmit) → KEEP `existing`.
 *   - neither is a prefix of the other    → genuine delta → APPEND.
 *
 * Pure + exported so the snapshot-vs-delta behaviour is unit-tested
 * without spinning up a full ACP session.
 */
export function reconcileCumulative(existing: string, incoming: string): string {
  if (incoming.length === 0) return existing;
  // Snapshot that extends (or exactly equals) what we have — the common
  // case for both the first chunk (existing === '') and every growing
  // snapshot. Replacing is idempotent for an exact re-send.
  if (incoming.startsWith(existing)) return incoming;
  // Stale / shorter snapshot of the same prefix — ignore it so a
  // late-arriving earlier frame can't truncate the reply.
  if (existing.startsWith(incoming)) return existing;
  // Disjoint → the adapter is sending true deltas; append.
  return existing + incoming;
}

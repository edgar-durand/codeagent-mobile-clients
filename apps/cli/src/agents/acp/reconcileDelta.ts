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
 *   - incoming SHARES a long common prefix with existing but isn't an exact
 *     `startsWith` (real-Claude whitespace / segmentation drift on the
 *     consolidated re-emit) → still a snapshot, NOT a delta: take only the
 *     net-new suffix past the shared prefix so the reply doesn't double on a
 *     one-character drift. When the shared prefix covers ALL of existing it's
 *     a clean REPLACE; otherwise we keep existing + the divergent suffix.
 *   - neither is a prefix of the other AND the shared prefix is short →
 *     genuine delta → APPEND.
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
  // Prefix-drift snapshot: incoming re-sends most of existing but diverges
  // partway (a whitespace/segmentation difference on the consolidated
  // re-emit, observed on real Claude). Detect it by a shared common prefix
  // that's a substantial fraction of existing — far longer than a few bytes
  // a genuine first delta could coincidentally share. Treat as a snapshot:
  // emit existing's prefix + incoming's divergent tail (the net-new suffix),
  // so a tiny drift can't double the reply via APPEND.
  const shared = commonPrefixLength(existing, incoming);
  if (shared > 0 && shared >= existing.length / 2) {
    // existing[0..shared) === incoming[0..shared); the canonical text is the
    // shared prefix followed by whatever the (longer/newer) snapshot carries
    // past it. Equivalent to a REPLACE when shared === existing.length.
    return existing.slice(0, shared) + incoming.slice(shared);
  }
  // Disjoint (or only a trivial shared prefix) → true delta; append.
  return existing + incoming;
}

/** Length of the longest common prefix of two strings. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

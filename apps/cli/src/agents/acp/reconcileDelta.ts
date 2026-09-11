/**
 * Reconcile a streaming text segment against what we've already
 * accumulated for the same chunk, transparently handling BOTH wire
 * conventions an ACP adapter can use for `agent_message_chunk`:
 *
 *   - **true deltas** — each notification carries only the NEW bytes
 *     since the last one. This is what the ACP spec defines for
 *     `agent_message_chunk` and what `claude-agent-acp` forwards from
 *     Anthropic's `text_delta` stream events (`dist/acp-agent.js`, the
 *     `stream_event` case). Reconciliation appends.
 *
 *   - **cumulative snapshots** — each notification carries the FULL
 *     message-so-far. Two real sources:
 *       1. The house "CodeAgent Cloud" agent's self-hosted MiniMax proxy:
 *          the upstream SSE ships `message.content` snapshots as
 *          `text_delta`s and the adapter forwards each as a fresh
 *          `agent_message_chunk` (commit 926e81d0 — the "…hoy?¡Hola!…hoy?"
 *          intra-reply duplication). Blind `+=` doubles the reply.
 *       2. `claude-agent-acp`'s consolidated `assistant` message: it diffs
 *          each assembled block against what already streamed and forwards
 *          only the un-streamed tail (a true delta) — but when the streamed
 *          text is NOT a prefix of the assembled block (whitespace /
 *          segmentation drift) it re-sends the WHOLE block (the "Not
 *          matched … forward the block in full" branch). That re-emit
 *          shares a long prefix with `existing` and diverges near the end.
 *     Reconciliation REPLACES (or keeps the shared prefix + the new tail).
 *
 * THE RULE — a snapshot is recognisable by SIZE, a delta is not:
 *
 *   - `incoming` starts with `existing` → snapshot that grew (or an exact
 *     re-send) → REPLACE with `incoming`. Covers the first chunk too
 *     (`existing === ''`). A true delta can only land here when `existing`
 *     is a run of repeated bytes the delta happens to extend ("\n" then
 *     "\n\n") — a whitespace-only loss we accept.
 *   - otherwise `incoming` is a snapshot ONLY IF it is long relative to
 *     `existing`: a re-sent snapshot carries the whole message-so-far, so it
 *     is at least about as long as what we hold (`>= half`, to absorb
 *     drift), AND it shares a long common prefix with `existing`
 *     (`>= half` of existing AND at least {@link MIN_SNAPSHOT_PREFIX} bytes,
 *     so a one-byte coincidence on a two-byte reply can't qualify). Then
 *     keep `existing`'s shared prefix + `incoming`'s divergent tail (a clean
 *     REPLACE when the prefix covers all of existing; `existing` unchanged
 *     when `incoming` is a strict prefix of it — a stale re-send never
 *     truncates).
 *   - everything else is a genuine delta → APPEND. In particular a SHORT
 *     `incoming` that happens to be a prefix of `existing` ("\n\n" or
 *     "\n\nMa" after a reply that opened with "\n\nMaintenant…") is a delta,
 *     not a stale snapshot: the old `existing.startsWith(incoming) → keep`
 *     rule dropped exactly those bytes and rendered "n°209).intenant" /
 *     "signature.Je" (2026-09-10 review, wswp26jc9p f355–f374). ACP is a
 *     JSON-RPC stream over stdio — notifications arrive in order, so a
 *     shorter *earlier* snapshot re-arriving late is not a real shape; the
 *     only real short-prefix case is the delta.
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
  const shared = commonPrefixLength(existing, incoming);
  if (looksLikeSnapshot(existing, incoming, shared)) {
    // existing[0..shared) === incoming[0..shared); the canonical text is the
    // shared prefix followed by whatever the (longer/newer) snapshot carries
    // past it. When `incoming` is a strict prefix of `existing` its tail is
    // empty and that would TRUNCATE — a stale re-send must never shrink the
    // reply, so keep `existing` whole.
    if (shared === incoming.length) return existing;
    return existing.slice(0, shared) + incoming.slice(shared);
  }
  // Disjoint, a trivial shared prefix, or too short to be a re-sent
  // snapshot → true delta; append.
  return existing + incoming;
}

/**
 * Minimum shared-prefix length (bytes) before `incoming` can be read as a
 * re-sent snapshot rather than a delta. A genuine delta never repeats the
 * reply's opening bytes on purpose; a coincidental overlap is one or two
 * bytes of whitespace/punctuation, never eight.
 */
const MIN_SNAPSHOT_PREFIX = 8;

/**
 * `incoming` is a re-sent snapshot of `existing` (see the rule on
 * {@link reconcileCumulative}): long relative to existing AND sharing a long
 * prefix with it. Everything else is a delta.
 */
function looksLikeSnapshot(existing: string, incoming: string, shared: number): boolean {
  return (
    shared >= MIN_SNAPSHOT_PREFIX &&
    shared * 2 >= existing.length &&
    incoming.length * 2 >= existing.length
  );
}

/** Length of the longest common prefix of two strings. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/**
 * `codeam-handoff` fence protocol -- extraction/validation of an agent-proposed
 * handoff embedded at the tail of a reply, plus the partial-fence-start
 * detector the streaming layer uses to truncate live output before the fence
 * body exists (the app renders the proposal as a card -- protocol litter must
 * never reach the user).
 *
 * The active agent proposes a handoff by ending its reply with a fenced code
 * block tagged `codeam-handoff` containing ONE JSON object:
 *   {"to":"<teammate id>","reason":"<one sentence>","prompt":"<the prompt they should run>"}
 * (see `squad-roster.ts` `buildTeamPreamble`, which instructs the agent to do
 * this).
 */
import {
  AGENT_REGISTRY,
  HANDOFF_FENCE_TAG,
  normalizeAgentId,
  publicToInternal,
} from '@codeam/shared';
import { log } from '../../services/logger';

export interface ExtractedHandoff {
  cleanText: string; // reply text with the fence removed
  proposal: { to: string; reason: string; prompt: string } | null;
}

const REASON_MAX = 1000;
const PROMPT_MAX = 8000;

const FENCE_OPEN = '```' + HANDOFF_FENCE_TAG;
// Non-greedy across the whole text; `g` so we can collect every fence.
const FENCE_RE = new RegExp('```' + HANDOFF_FENCE_TAG + '\\s*\\n([\\s\\S]*?)\\n?```', 'g');

// The degenerate/inline form a model emits when it treats the protocol tag
// as an inline mention instead of a fenced block: `codeam-handoff` followed
// by ONE JSON object on the SAME line, wrapped in 0-2 backticks (bare text,
// or a single/double-backtick inline code span). Anchored to the WHOLE line
// (`^...$`) so it can never match a mid-sentence mention of the tag, or a
// line with trailing prose after the JSON. The backreference (`\1`) requires
// the CLOSING backtick count to match the OPENING one, so a stray trailing
// backtick from unrelated prose can't be swallowed.
//
// Tested against ONE LINE AT A TIME (via `trailingDegenerateMatch`, never
// `matchAll` over the whole text) — no `g`/`m` flags. See that function for
// why: a degenerate match only counts when it's the reply's actual TAIL.
const DEGENERATE_LINE_RE = new RegExp(
  '^[ \\t]*(`{0,2})[ \\t]*' + HANDOFF_FENCE_TAG + '[ \\t]+(\\{.*\\})[ \\t]*\\1[ \\t]*\\r?$',
);

// A fence opened with 4+ backticks is the agent quoting the protocol itself
// as a worked example (e.g. explaining how handoffs work) -- any
// codeam-handoff fence nested inside it must be shown to the user verbatim,
// never stripped or parsed as a real proposal. The backreference requires
// the SAME backtick count to close, so this only matches genuine outer
// fences, never the 3-backtick codeam-handoff fence itself.
const OUTER_FENCE_RE = /(`{4,})[\s\S]*?\1/g;
// A plain ASCII placeholder that never appears in real agent output, so it
// can't collide with surrounding prose and survives the seam-collapse pass
// untouched (it contains no newlines).
const outerFencePlaceholder = (i: number): string => `@@HANDOFF_MASK_${i}@@`;

/** Replace every 4+-backtick-fenced span with an opaque placeholder so the
 * `codeam-handoff` matcher never looks inside a quoted example. Returns the
 * masked text plus a restorer that puts the original spans back verbatim. */
function maskOuterFences(text: string): { masked: string; restore: (s: string) => string } {
  const spans: string[] = [];
  const masked = text.replace(OUTER_FENCE_RE, (m) => {
    const token = outerFencePlaceholder(spans.length);
    spans.push(m);
    return token;
  });
  const restore = (s: string): string =>
    spans.reduce((acc, span, i) => acc.split(outerFencePlaceholder(i)).join(span), s);
  return { masked, restore };
}

interface RawProposalShape {
  to: string;
  reason: string;
  prompt: string;
}

/**
 * Parse `raw` as a JSON object with the handoff proposal SHAPE — non-empty
 * `to`/`reason`/`prompt` strings within the size caps — WITHOUT resolving
 * `to` against any roster and WITHOUT the not-the-current-agent check. Those
 * two checks need context (`validTargets`/`currentAgent`) this function
 * doesn't have. Used by {@link parseProposal} (which layers the
 * context-dependent checks on top) AND by {@link stripHandoffFences}'s
 * degenerate-strip decision, which has no session context at all
 * (presentation-only). Returns the raw, UNRESOLVED `to` — callers that need
 * the resolved id go through {@link resolveHandoffTarget}.
 */
function parseProposalShape(raw: string): RawProposalShape | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { to, reason, prompt } = parsed as Record<string, unknown>;
  if (typeof to !== 'string' || to.length === 0) return null;
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > REASON_MAX) {
    return null;
  }
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > PROMPT_MAX) {
    return null;
  }
  return { to, reason, prompt };
}

/**
 * Resolve a handoff `to` value the agent may have supplied in ANY spelling
 * the model plausibly emits, onto the runtime {@link AgentId} the CALLER's
 * roster actually has (`validTargets`) — case/whitespace tolerant:
 *
 *   1. Verbatim (case-insensitive) match against a member of `validTargets`.
 *   2. A known runtime-id alias — `claude_code`, `claude-code`,
 *      `__terminal__:claude`, etc. — via the shared `normalizeAgentId`.
 *   3. A public `LinkedAgentId` (`claude_code`, `gemini`, …) via the shared
 *      `publicToInternal`.
 *   4. A shared-registry DISPLAY NAME, case-insensitive — `"Claude Code"` →
 *      `claude`, `"Gemini CLI"` → `gemini`, `"Kimi Code"` → `kimi` (bare
 *      `"Kimi"` is already covered by step 1 — the registry id itself is
 *      `kimi`).
 *
 * Unknown, or resolved but not on THIS roster → `null`.
 */
export function resolveHandoffTarget(
  raw: string,
  validTargets: ReadonlySet<string>,
): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  for (const target of validTargets) {
    if (target.toLowerCase() === lower) return target;
  }

  const viaAlias = normalizeAgentId(trimmed);
  if (viaAlias && validTargets.has(viaAlias)) return viaAlias;

  const viaPublic = publicToInternal(lower);
  if (viaPublic && validTargets.has(viaPublic)) return viaPublic;

  for (const meta of Object.values(AGENT_REGISTRY)) {
    if (meta.displayName.toLowerCase() === lower && validTargets.has(meta.id)) {
      return meta.id;
    }
  }

  return null;
}

function parseProposal(
  raw: string,
  currentAgent: string,
  validTargets: ReadonlySet<string>,
): { to: string; reason: string; prompt: string } | null {
  const shape = parseProposalShape(raw);
  if (!shape) {
    log.debug('handoffProtocol', 'dropped proposal: malformed JSON or invalid shape');
    return null;
  }
  const to = resolveHandoffTarget(shape.to, validTargets);
  if (!to) {
    log.debug('handoffProtocol', `dropped proposal: unknown target "${shape.to}"`);
    return null;
  }
  if (to === currentAgent) {
    log.debug('handoffProtocol', 'dropped proposal: target is the current agent');
    return null;
  }
  return { to, reason: shape.reason, prompt: shape.prompt };
}

/** Collapse any blank-line run (LF or CRLF) left at a removed-fence seam down
 * to at most one blank line, and trim the ends. Shared by the strict-fence
 * strip and the degenerate-form strip. */
function collapseSeams(s: string): string {
  return s.replace(/(?:\r?\n){3,}/g, '\n\n').trim();
}

/** Strip ALL top-level fences from already-masked text (the masked
 * outer-fenced examples are opaque tokens here, so their nested fences are
 * untouched), collapsing any blank-line runs (LF or CRLF) left at the seams. */
function stripFences(masked: string): string {
  return collapseSeams(masked.replace(FENCE_RE, ''));
}

/**
 * The LAST non-blank line of `masked`, trailing blank lines skipped, plus its
 * start offset in `masked`. Null when the text is empty or entirely blank.
 */
function lastNonBlankLine(masked: string): { line: string; start: number } | null {
  const parts = masked.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const p of parts) {
    starts.push(offset);
    offset += p.length + 1; // +1 accounts for the '\n' separator.
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].trim().length > 0) return { line: parts[i], start: starts[i] };
  }
  return null;
}

/**
 * A degenerate match, but ONLY when it's on the reply's actual TAIL — the
 * last non-blank line of `masked` (trailing blank lines are fine; the
 * protocol contract is "end your reply with…", so a worked example earlier
 * in a longer reply must never be mistaken for a live proposal).
 *
 * ⚠️ Found the hard way: matching a degenerate mention ANYWHERE in the text
 * (the original `matchAll`-based implementation) let an agent EXPLAINING the
 * protocol mid-reply — "to hand this off you'd write `codeam-handoff
 * {...}` but only when it fits" — get mistaken for a live, fully-resolved
 * proposal, AND silently deleted the explanatory line out of the visible
 * reply. Restricting to the trailing line closes that false-positive class
 * while still catching the real incident (the proposal genuinely WAS the
 * last thing in the reply).
 */
function trailingDegenerateMatch(
  masked: string,
): { match: RegExpMatchArray; start: number } | null {
  const last = lastNonBlankLine(masked);
  if (!last) return null;
  const match = last.line.match(DEGENERATE_LINE_RE);
  return match ? { match, start: last.start } : null;
}

/** Find + strip a ```codeam-handoff fence. Validates: parseable single JSON
 * object; to is in validTargets; to != currentAgent; reason/prompt non-empty
 * strings (prompt <= 8000, reason <= 1000). Invalid -> proposal:null but the
 * fence is STILL stripped (never show protocol litter to the user).
 *
 * A codeam-handoff fence nested inside an outer 4+-backtick block (the agent
 * quoting the protocol as an example) is masked out first -- it is neither
 * stripped nor parsed, so the user sees the example verbatim.
 *
 * When there's no strict fence, falls back to the DEGENERATE (bare / inline-
 * code) form — `codeam-handoff {...}` on one line — but ONLY when that line
 * is the reply's TRAILING content (the last non-blank line; see {@link
 * trailingDegenerateMatch}). Unlike the strict fence, the degenerate form is
 * treated as a proposal AND stripped ONLY when the JSON parses AND fully
 * validates (target resolves on THIS roster, via {@link
 * resolveHandoffTarget}, and isn't the current agent). An invalid degenerate
 * match — including one that isn't on the trailing line — leaves the text
 * COMPLETELY untouched: never eat prose that merely mentions the tag. */
export function extractHandoffProposal(
  text: string,
  currentAgent: string,
  validTargets: ReadonlySet<string>,
): ExtractedHandoff {
  const { masked, restore } = maskOuterFences(text);
  const matches = [...masked.matchAll(FENCE_RE)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    const proposal = parseProposal(last[1].trim(), currentAgent, validTargets);
    const cleanText = restore(stripFences(masked));
    return { cleanText, proposal };
  }

  const degenerate = trailingDegenerateMatch(masked);
  if (degenerate) {
    const proposal = parseProposal(degenerate.match[2].trim(), currentAgent, validTargets);
    if (proposal) {
      const { start } = degenerate;
      const stripped = masked.slice(0, start) + masked.slice(start + degenerate.match[0].length);
      return { cleanText: restore(collapseSeams(stripped)), proposal };
    }
    // Malformed JSON, wrong shape, or a target that doesn't resolve on this
    // roster — never strip; the text is byte-identical to the input.
    return { cleanText: text, proposal: null };
  }

  return { cleanText: text, proposal: null };
}

/** Presentation-only, masked-aware fence-stripped view of `text` -- the same
 * `cleanText` `extractHandoffProposal` produces for the STRICT fence, without
 * needing `currentAgent`/`validTargets`. Used by the runner's TERMINAL frames
 * (`closeAll` / `closeTurnWithInteractiveDetection` / the final
 * `flushStreamingChunks` pass), where truncating on an UNMASKED fence start
 * would permanently cut a reply that merely quotes the protocol as an
 * example inside a 4+-backtick block.
 *
 * For the DEGENERATE form this function has no session context to fully
 * validate against (no roster, no current agent) — it strips a degenerate
 * match, when it's on the reply's TRAILING line (see {@link
 * trailingDegenerateMatch}), if the JSON has the proposal SHAPE
 * (`parseProposalShape`: parses, non-empty `to`/`reason`/`prompt` within the
 * size caps), without resolving `to`. That's deliberately looser than
 * `extractHandoffProposal`'s durable `cleanText` (which additionally
 * requires the target to resolve on the live roster) — the alternative is
 * leaking a raw JSON blob into the user's chat bubble for a merely-mistyped
 * target, which is worse than an occasional over-eager strip of a
 * shape-valid trailing block. A block that isn't even shape-valid JSON, or
 * isn't on the trailing line, is still never touched (never eat unrelated
 * prose — including a worked example mid-reply). */
export function stripHandoffFences(text: string): string {
  const { masked, restore } = maskOuterFences(text);
  if (masked.search(FENCE_RE) !== -1) {
    return restore(stripFences(masked));
  }

  const degenerate = trailingDegenerateMatch(masked);
  if (degenerate && parseProposalShape(degenerate.match[2].trim())) {
    const { start } = degenerate;
    const stripped = masked.slice(0, start) + masked.slice(start + degenerate.match[0].length);
    return restore(collapseSeams(stripped));
  }

  // No real fence, no shape-valid degenerate match: byte-identical
  // passthrough. The seam collapse + trim must never touch fence-less
  // replies — this runs on EVERY terminal frame, not just squad turns.
  // (String#search ignores the /g lastIndex, so the module-level FENCE_RE
  // stays stateless here.)
  return text;
}

/**
 * Index of the STRICT fence START in `text`, or -1. Used by the streaming
 * layer to truncate LIVE publishes so the protocol block never renders
 * mid-stream, before the fence body (and thus the degenerate-form JSON, if
 * any) has fully arrived.
 *
 * ⚠️ Deliberately does NOT also detect the degenerate/inline form. Unlike
 * the strict fence (whose `\`\`\`codeam-handoff` open marker is a reliable,
 * unambiguous early signal), a degenerate match can only be confirmed once
 * the WHOLE line — including the closing `}` and optional backtick — has
 * streamed in; cutting speculatively on `codeam-handoff` mid-line would risk
 * truncating a live reply that turns out to be ordinary prose mentioning the
 * tag. That's not "trivially safe", so it's left as-is. This is fine in
 * practice: `stripHandoffFences` (the TERMINAL-frame strip, called once the
 * turn's full text is known) is what actually kills degenerate-form litter
 * before it persists — see `closeAll`/`closeTurnWithInteractiveDetection` in
 * `runner.ts`. A degenerate block may render for the LIVE duration of the
 * single line it's on, then disappear from the terminal frame.
 */
export function handoffFenceStart(text: string): number {
  return text.indexOf(FENCE_OPEN);
}

/**
 * Masked-aware version of {@link handoffFenceStart} — the live-stream cut
 * point (STRICT fence only — see the note on {@link handoffFenceStart} for
 * why the degenerate form isn't part of the live cut). `handoffFenceStart`
 * cuts on the RAW text, so a `codeam-handoff`
 * fence-open marker the agent is merely QUOTING as a worked example inside a
 * closed 4+-backtick block (see `maskOuterFences`) gets mistaken for a real
 * proposal and truncates the live view for the rest of the turn — the
 * example never "closes" from the live cut's perspective because the real
 * fence-open substring already matched. This masks outer-fenced spans first,
 * so only a fence-open OUTSIDE one of them can trigger a live cut.
 *
 * Placeholders (`@@HANDOFF_MASK_<n>@@`) can never contain the fence-open
 * marker themselves, so `masked` containing NO `FENCE_OPEN` means every raw
 * occurrence is quoted inside a masked span — nothing to cut on. Otherwise
 * we re-scan the RAW text directly for the first `FENCE_OPEN` that does NOT
 * fall inside an outer-fence span; that's guaranteed to exist (it's exactly
 * what made `masked` contain one) and is the fence to cut at.
 */
export function handoffFenceStartMasked(text: string): number {
  const { masked } = maskOuterFences(text);
  if (masked.indexOf(FENCE_OPEN) === -1) return -1;

  // Outer-fence spans in the RAW text — a `FENCE_OPEN` match inside one of
  // these is a quoted example, not a real fence.
  const spans: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(OUTER_FENCE_RE)) {
    const start = m.index ?? 0;
    spans.push({ start, end: start + m[0].length });
  }
  const insideSpan = (idx: number): boolean => spans.some((s) => idx >= s.start && idx < s.end);

  for (let i = text.indexOf(FENCE_OPEN); i !== -1; i = text.indexOf(FENCE_OPEN, i + 1)) {
    if (!insideSpan(i)) return i;
  }
  return -1;
}

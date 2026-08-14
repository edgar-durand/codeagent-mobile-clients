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
import { HANDOFF_FENCE_TAG } from '@codeam/shared';
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

function parseProposal(
  raw: string,
  currentAgent: string,
  validTargets: ReadonlySet<string>,
): { to: string; reason: string; prompt: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.debug('handoffProtocol', 'dropped proposal: malformed JSON');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    log.debug('handoffProtocol', 'dropped proposal: not a JSON object');
    return null;
  }
  const { to, reason, prompt } = parsed as Record<string, unknown>;
  if (typeof to !== 'string' || to.length === 0) {
    log.debug('handoffProtocol', 'dropped proposal: missing/invalid "to"');
    return null;
  }
  if (!validTargets.has(to)) {
    log.debug('handoffProtocol', `dropped proposal: unknown target "${to}"`);
    return null;
  }
  if (to === currentAgent) {
    log.debug('handoffProtocol', 'dropped proposal: target is the current agent');
    return null;
  }
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > REASON_MAX) {
    log.debug('handoffProtocol', 'dropped proposal: invalid "reason"');
    return null;
  }
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > PROMPT_MAX) {
    log.debug('handoffProtocol', 'dropped proposal: invalid "prompt"');
    return null;
  }
  return { to, reason, prompt };
}

/** Strip ALL top-level fences from already-masked text (the masked
 * outer-fenced examples are opaque tokens here, so their nested fences are
 * untouched), collapsing any blank-line runs (LF or CRLF) left at the seams. */
function stripFences(masked: string): string {
  const stripped = masked.replace(FENCE_RE, '');
  return stripped.replace(/(?:\r?\n){3,}/g, '\n\n').trim();
}

/** Find + strip a ```codeam-handoff fence. Validates: parseable single JSON
 * object; to is in validTargets; to != currentAgent; reason/prompt non-empty
 * strings (prompt <= 8000, reason <= 1000). Invalid -> proposal:null but the
 * fence is STILL stripped (never show protocol litter to the user).
 *
 * A codeam-handoff fence nested inside an outer 4+-backtick block (the agent
 * quoting the protocol as an example) is masked out first -- it is neither
 * stripped nor parsed, so the user sees the example verbatim. */
export function extractHandoffProposal(
  text: string,
  currentAgent: string,
  validTargets: ReadonlySet<string>,
): ExtractedHandoff {
  const { masked, restore } = maskOuterFences(text);
  const matches = [...masked.matchAll(FENCE_RE)];
  if (matches.length === 0) {
    return { cleanText: text, proposal: null };
  }

  const last = matches[matches.length - 1];
  const proposal = parseProposal(last[1].trim(), currentAgent, validTargets);
  const cleanText = restore(stripFences(masked));

  return { cleanText, proposal };
}

/** Presentation-only, masked-aware fence-stripped view of `text` -- the same
 * `cleanText` `extractHandoffProposal` produces, without needing
 * `currentAgent`/`validTargets` since this never parses a proposal. Used by
 * the runner's TERMINAL frames (`closeAll` / `closeTurnWithInteractiveDetection`
 * / the final `flushStreamingChunks` pass), where truncating on an UNMASKED
 * fence start would permanently cut a reply that merely quotes the protocol
 * as an example inside a 4+-backtick block. */
export function stripHandoffFences(text: string): string {
  const { masked, restore } = maskOuterFences(text);
  return restore(stripFences(masked));
}

/** Index of the fence START in `text`, or -1. Used by the streaming layer to
 * truncate live publishes so the protocol block never renders. */
export function handoffFenceStart(text: string): number {
  return text.indexOf(FENCE_OPEN);
}

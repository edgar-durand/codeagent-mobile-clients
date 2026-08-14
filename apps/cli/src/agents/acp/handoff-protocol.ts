/**
 * `codeam-handoff` fence protocol — extraction/validation of an agent-proposed
 * handoff embedded at the tail of a reply, plus the partial-fence-start
 * detector the streaming layer uses to truncate live output before the fence
 * body exists (the app renders the proposal as a card — protocol litter must
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

/** Find + strip a ```codeam-handoff fence. Validates: parseable single JSON
 * object; to ∈ validTargets; to ≠ currentAgent; reason/prompt non-empty
 * strings (prompt ≤ 8000, reason ≤ 1000). Invalid → proposal:null but the
 * fence is STILL stripped (never show protocol litter to the user). */
export function extractHandoffProposal(
  text: string,
  currentAgent: string,
  validTargets: ReadonlySet<string>,
): ExtractedHandoff {
  const matches = [...text.matchAll(FENCE_RE)];
  if (matches.length === 0) {
    return { cleanText: text, proposal: null };
  }

  const last = matches[matches.length - 1];
  const proposal = parseProposal(last[1].trim(), currentAgent, validTargets);

  // Strip ALL fences, then collapse any blank-line runs left at the seams so
  // the surrounding text reads cleanly.
  const stripped = text.replace(FENCE_RE, '');
  const cleanText = stripped.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanText, proposal };
}

/** Index of the fence START in `text`, or -1. Used by the streaming layer to
 * truncate live publishes so the protocol block never renders. */
export function handoffFenceStart(text: string): number {
  return text.indexOf(FENCE_OPEN);
}

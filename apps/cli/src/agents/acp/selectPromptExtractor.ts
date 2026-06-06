/**
 * Detect a free-form "question + numbered options" pattern at the
 * tail of an agent's final reply text.
 *
 * ACP has exactly one wire shape for interactive prompts —
 * `session/request_permission` — and it only fires for tool
 * permissions. When an agent (Gemini commonly) asks the user a
 * free-form question with numbered options, it just emits prose:
 *
 *   ¿Quieres continuar?
 *
 *   1. Aplicar refactorización
 *   2. Ver plan detallado
 *   3. Cancelar
 *
 * Mobile renders that as plain text — no tappable buttons — even
 * though the legacy chat pipe knows how to render a
 * `type: 'select_prompt'` chunk as buttons (Claude PTY agents have
 * always emitted those via their own per-agent parser).
 *
 * This extractor closes that gap for ACP agents: detect the trailing
 * options list, pull it out, and the {@link runner} emits a
 * `select_prompt` chunk for mobile + tracks the options in
 * `StreamingState` so the matching `select_option` relay command
 * resolves to a new ACP prompt with the picked text.
 *
 * Conservatism is the goal — we'd rather miss a borderline case than
 * mis-detect a numbered list inside prose as an interactive prompt
 * and turn the chat into a button maze. The heuristics:
 *
 *   - Min 2, max {@link MAX_OPTIONS} contiguous numbered lines.
 *   - Numbering must be sequential starting at the FIRST item's
 *     number (1, 2, 3 — not 1, 4, 7). The first number doesn't have
 *     to be 1 because some agents (Codex) start at 0 or skip the
 *     1-based convention.
 *   - Each option's body must be ≤ {@link MAX_OPTION_BODY_CHARS}.
 *   - The numbered run must be the LAST non-empty block of the text;
 *     a numbered list followed by more prose is documentation, not
 *     an interactive prompt.
 *   - Optional question: the last non-empty line BEFORE the run that
 *     ends in `?` or `:`. When absent, the prompt still extracts but
 *     `question` comes back as `null` and the runner falls back to a
 *     generic "Pick an option" label.
 */

/** Hard cap so a long enumerated list in docs (e.g. "1-10 of things")
 *  never trips the detector. UX-wise > 6 options is also a button
 *  maze, so this doubles as a render-quality guard. */
const MAX_OPTIONS = 6;

/** Each option's body must be short — a numbered paragraph is prose,
 *  not a button label. 200 chars matches the typical button-render
 *  width budget on mobile. */
const MAX_OPTION_BODY_CHARS = 200;

const NUMBERED_LINE_RE = /^\s*(\d+)[.)\]]\s+(.+)$/;

export interface ExtractedSelectPrompt {
  /** All text BEFORE the question + options block — empty string when
   *  the entire reply was just the prompt. */
  textBefore: string;
  /** The question line stripped of trailing punctuation, or `null`
   *  when no question was detected. */
  question: string | null;
  /** Option bodies in order — `options[0]` is for index 0. */
  options: string[];
}

export function extractSelectPrompt(text: string): ExtractedSelectPrompt | null {
  if (text.length === 0) return null;

  const lines = text.split('\n');
  // Walk backward over trailing empties so a turn that ended with
  // `\n\n` still detects the options block above.
  let endIdx = lines.length - 1;
  while (endIdx >= 0 && lines[endIdx].trim() === '') endIdx--;
  if (endIdx < 0) return null;

  // Walk further backward collecting contiguous numbered lines.
  const items: { num: number; body: string; lineIdx: number }[] = [];
  let i = endIdx;
  while (i >= 0) {
    const m = lines[i].match(NUMBERED_LINE_RE);
    if (!m) break;
    const body = m[2].trim();
    if (body.length === 0 || body.length > MAX_OPTION_BODY_CHARS) {
      // Body that's too long or empty disqualifies the candidate
      // entirely — partial detection ("first 3 lines are options,
      // 4th is a paragraph") is worse than no detection.
      return null;
    }
    items.unshift({ num: parseInt(m[1], 10), body, lineIdx: i });
    if (items.length > MAX_OPTIONS) return null;
    i--;
  }

  if (items.length < 2) return null;

  // Sequential numbering, anchored to whatever the first item used.
  const baseNum = items[0].num;
  for (let j = 0; j < items.length; j++) {
    if (items[j].num !== baseNum + j) return null;
  }

  // Walk further backward for the question — last non-empty line
  // above the numbered run, must end in `?` or `:` to qualify.
  let questionLineIdx: number | null = null;
  let question: string | null = null;
  const firstItemLine = items[0].lineIdx;
  for (let j = firstItemLine - 1; j >= 0; j--) {
    const trimmed = lines[j].trim();
    if (trimmed === '') continue;
    if (/[?:]\s*$/.test(trimmed)) {
      question = trimmed.replace(/\s*[?:]+\s*$/, '').trim() || trimmed;
      questionLineIdx = j;
    }
    break;
  }

  const textBeforeEnd = questionLineIdx ?? firstItemLine;
  const textBefore = lines
    .slice(0, textBeforeEnd)
    .join('\n')
    .replace(/\n+$/, '');

  return {
    textBefore,
    question,
    options: items.map((it) => it.body),
  };
}

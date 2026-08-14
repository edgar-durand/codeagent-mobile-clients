/**
 * Agent Squad — NATIVE context delivery + the legacy-marker scrubber.
 *
 * **The P0 bug this fixes (fleet-1, 2026-08-14):** the team preamble / delta
 * briefing / post-switch handoff preamble rode the prompt as plain `text`
 * blocks. The agent's own JSONL therefore recorded them as part of the USER
 * message, and the hydration path (HistoryService → `/api/sessions/conversation`)
 * replayed them as a visible user bubble — the user saw
 * `[Session handoff] You (Codex) are taking over…` in their own chat.
 *
 * **The fix (same rails as skills injection,
 * `2026-07-19-agent-skills-injection-design.md`):** deliver it as ONE ACP
 * `ContentBlock::Resource` (an `EmbeddedResource` with our own
 * `codeam://squad-context` uri) — semantically *context*, not user words, so
 * conforming agents keep it out of the transcript's user message.
 *
 * Two halves live here:
 *  1. {@link buildSquadContextBlock} / {@link SQUAD_CONTEXT_URI} — the native
 *     block, plus {@link isSquadContextBlock} for the fallback swap.
 *  2. {@link stripSquadContext} — a pure scrubber for text that ALREADY
 *     carries the legacy markers (pre-fix history on disk, and any adapter
 *     that fell back to text blocks). Byte-identical passthrough when no
 *     marker is present, so it is safe on EVERY hydrated message.
 */
import type { PromptBlock } from './buildAcpPromptBlocks';
import {
  BRIEFING_FOOTER,
  BRIEFING_MARKER,
  TEAM_PREAMBLE_BULLET_RE,
  TEAM_PREAMBLE_LINES,
  TEAM_PREAMBLE_MARKER,
} from './squad-roster';

/** Our own uri for the embedded squad-context resource. Not a real file. */
export const SQUAD_CONTEXT_URI = 'codeam://squad-context';

const HANDOFF_MARKER = '[Session handoff]';
const HANDOFF_TERMINATOR = '--- End of handoff context ---';

/**
 * Wrap the composed squad context (team preamble + delta briefing + pending
 * handoff, already joined) into the single native resource block.
 */
export function buildSquadContextBlock(text: string): PromptBlock {
  return {
    type: 'resource',
    resource: { uri: SQUAD_CONTEXT_URI, mimeType: 'text/plain', text },
  };
}

/** True for a block produced by {@link buildSquadContextBlock}. */
export function isSquadContextBlock(block: PromptBlock): boolean {
  return block.type === 'resource' && block.resource.uri === SQUAD_CONTEXT_URI;
}

/**
 * True when an adapter rejected a prompt because it could not accept the
 * shape we sent — the ONE condition that earns a text-block retry.
 *
 * Deliberately NARROW. A retry re-runs the whole turn, so a broad matcher
 * would double-execute real work on an unrelated failure. We accept only a
 * JSON-RPC `-32602 Invalid params` (the code an adapter returns for a
 * content-block shape it can't deserialize) or an explicit
 * "resource … not supported" phrasing.
 */
export function looksLikeUnsupportedPromptShape(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === -32602) return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (/invalid[ _]params|-32602/i.test(message)) return true;
  return /\bresource\b/i.test(message) && /unsupported|not supported/i.test(message);
}

/** Consume `lines[i…]` while the predicate holds; returns the next index. */
function skipWhile(
  lines: readonly string[],
  start: number,
  keepGoing: (line: string) => boolean,
): number {
  let i = start;
  while (i < lines.length && keepGoing(lines[i])) i++;
  return i;
}

/**
 * Index just past a `[Team context]` block starting at `start`, or `-1` when
 * the lines at `start` are not a real preamble.
 *
 * The preamble has NO terminator line, so its two fixed opening literals ARE
 * the gate — mirroring how the other two markers gate on their terminator.
 * ⚠️ A `startsWith('[Team context]')` test is NOT enough: a user message that
 * merely BEGINS with that text would be deleted wholesale. Both header lines
 * must match {@link TEAM_PREAMBLE_LINES} exactly; anything else is the user's
 * own words and is left byte-identical.
 *
 * Past the header the block has exactly two kinds of continuation line — a
 * teammate bullet and one of the fixed protocol literals — so the first line
 * that is neither ends it.
 */
function endOfTeamPreamble(lines: readonly string[], start: number): number {
  if (lines[start] !== TEAM_PREAMBLE_LINES[0]) return -1;
  if (lines[start + 1] !== TEAM_PREAMBLE_LINES[1]) return -1;
  return skipWhile(
    lines,
    start + 2,
    (line) => TEAM_PREAMBLE_BULLET_RE.test(line) || TEAM_PREAMBLE_LINES.includes(line),
  );
}

/**
 * Index just past a block that runs from `start` to its stable terminator
 * line, or `-1` when the terminator is absent.
 *
 * A missing terminator means the record was clipped (both generators always
 * emit theirs), and guessing where the block ends could eat the user's own
 * words — so the caller leaves such text UNTOUCHED rather than over-strip.
 */
function endOfTerminatedBlock(lines: readonly string[], start: number, terminator: string): number {
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trimEnd() === terminator) return i + 1;
  }
  return -1;
}

/**
 * Remove every legacy squad-context marker block from a message.
 *
 * Handles the three generators, each anchored on the literals its builder
 * emits (see `squad-roster.ts` / `switch-agent.ts`):
 *  - `[Session handoff] … --- End of handoff context ---`
 *  - `[Team update] … Continue from the CURRENT state of the working tree.`
 *  - `[Team context] …` (both exact header lines + teammate bullets + optional
 *    protocol lines)
 *
 * Markers can appear at the start, mid-message (the blocks were joined with
 * the user's text by the agent's own transcript writer), and more than once.
 * Every marker is GATED — on its terminator line, or (the preamble, which has
 * none) on its exact header pair. A marker whose gate doesn't match is the
 * user's own words: the input is then returned byte-identical, as it is when
 * no marker appears at all.
 */
export function stripSquadContext(text: string): string {
  if (
    !text.includes(HANDOFF_MARKER) &&
    !text.includes(BRIEFING_MARKER) &&
    !text.includes(TEAM_PREAMBLE_MARKER)
  ) {
    return text;
  }
  const lines = text.split('\n');
  const kept: string[] = [];
  let i = 0;
  let stripped = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith(HANDOFF_MARKER)) {
      const end = endOfTerminatedBlock(lines, i, HANDOFF_TERMINATOR);
      if (end !== -1) {
        i = end;
        stripped = true;
        continue;
      }
    } else if (line.startsWith(BRIEFING_MARKER)) {
      const end = endOfTerminatedBlock(lines, i, BRIEFING_FOOTER);
      if (end !== -1) {
        i = end;
        stripped = true;
        continue;
      }
    } else if (line.startsWith(TEAM_PREAMBLE_MARKER)) {
      const end = endOfTeamPreamble(lines, i);
      if (end !== -1) {
        i = end;
        stripped = true;
        continue;
      }
    }
    kept.push(line);
    i++;
  }
  // Nothing matched after all (a bare marker word, no real block) → byte-identical.
  if (!stripped) return text;
  return kept.join('\n').trim();
}

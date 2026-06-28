/**
 * Synthesise a composer `input_suggestion` chip from an ACP agent's
 * final reply text.
 *
 * ACP has no native "recommended next prompt" field, so we approximate
 * one from the reply itself: if the last non-empty line of the reply is
 * a short closing question, it is a reasonable "what to ask next" hint
 * and we surface it as a chip.
 *
 * Conservatism is intentional — we emit NOTHING rather than a noisy or
 * irrelevant suggestion:
 *   - Only the LAST non-empty line is considered (not multi-paragraph prose).
 *   - The line must end with `?`.
 *   - The line must be 8–200 characters (too-short → fragment; too-long → prose).
 *   - Empty input always returns null.
 */

const MIN_LEN = 8;
const MAX_LEN = 200;

/**
 * Returns the text for an `input_suggestion` chip, or `null` when the
 * reply doesn't produce a useful suggestion.
 */
export function deriveInputSuggestion(finalText: string): string | null {
  if (finalText.length === 0) return null;

  const lines = finalText.split('\n');
  // Walk backward to find the last non-empty line.
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === '') i--;
  if (i < 0) return null;

  const lastLine = lines[i].trim();
  if (!lastLine.endsWith('?')) return null;
  if (lastLine.length < MIN_LEN || lastLine.length > MAX_LEN) return null;

  return lastLine;
}

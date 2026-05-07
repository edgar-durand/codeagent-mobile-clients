import {
  detectListSelector,
  detectSelector,
  filterChrome,
  renderToLines,
  type SelectPrompt,
} from '@codeagent/shared';

/**
 * Pure functions over the raw PTY buffer — turn it into screen
 * lines, detect interactive selectors, extract conversational
 * content. No state, no I/O — just transforms.
 *
 * The CLI's transport-side state machine
 * (`OutputService.tick()`) calls these in sequence each tick:
 *   1. `renderLines(buffer)` → screen as a string[].
 *   2. `detectAnySelector(lines)` → `SelectPrompt | null`.
 *   3. `extractContent(lines)` → conversational text (no chrome).
 */

export function renderLines(buffer: string): string[] {
  return renderToLines(buffer);
}

/**
 * Returns whichever selector type matches, preferring the
 * numbered "❯ N. label" style; falls back to the list-style
 * "  ❯ label" used by /mcp / /model. Mirrors the legacy call
 * order in OutputService.tick().
 */
export function detectAnySelector(lines: string[]): SelectPrompt | null {
  return detectSelector(lines) ?? detectListSelector(lines);
}

/**
 * Extract the conversational content — strip TUI chrome,
 * collapse 3+ blank lines to 2, trim. Returns the empty string
 * when only chrome was on screen (typical during tool-call
 * thinking where nothing user-facing has been emitted yet).
 */
export function extractContent(lines: string[]): string {
  return filterChrome(lines).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

import { renderToLines } from '@codeagent/shared';

/**
 * Agent-AGNOSTIC line-renderer. Turns the raw PTY buffer (with ANSI cursor
 * moves, CR/LF quirks, alternate-screen escapes) into a clean array of
 * screen lines via the virtual terminal in @codeagent/shared.
 *
 * Selector detection and chrome filtering used to live here too, but they
 * are agent-specific now and belong on the RuntimeStrategy interface:
 *   - `runtime.detectInteractivePrompt(lines)` — Claude vs. Codex selectors.
 *   - `runtime.filterTuiOutput(lines)`         — strip per-agent chrome.
 * OutputService.tick() calls those strategy methods directly.
 */

export function renderLines(buffer: string): string[] {
  return renderToLines(buffer);
}

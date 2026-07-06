/**
 * TUI parsing for Cursor Agent.
 *
 * Cursor's `cursor-agent` ships a ratatui-style chrome similar
 * enough to Codex that the BASELINE parsers (filter / chrome /
 * selector) can be reused with conservative defaults. When real
 * Cursor PTY captures land (#82 follow-up), replace these with
 * fixture-driven implementations.
 *
 * Today they're intentionally permissive — strip ANSI noise, drop
 * spinners, surface anything that looks like an Ink-style selector.
 * Worst case the mobile feed shows a little more chrome than ideal;
 * better than dropping legitimate agent replies.
 */

import type { ChromeStep, SelectPrompt } from '@codeam/shared';

const ANSI_CSI = /\x1B\[[^@-~]*[@-~]/g;
const SPINNER_GLYPHS = /[⠁⠂⠄⠈⠐⠠⡀⢀⠃⠉⠘⠰⢠⡠⢄⡈⠆⠌⠴⢤⡁⢁⠅⠊⠒⠦⡂]/;

export function filterCursorChrome(lines: string[]): string[] {
  return lines.filter((line) => {
    const stripped = line.replace(ANSI_CSI, '').trim();
    if (stripped.length === 0) return false;
    if (SPINNER_GLYPHS.test(stripped)) return false;
    // Drop the bottom-of-screen status frames Cursor uses for
    // "Esc to interrupt" / "↑↓ to navigate" hints — they're chrome
    // not conversation.
    if (/^(esc|enter|↑↓|ctrl)[\s+]/i.test(stripped)) return false;
    return true;
  });
}

export function parseCursorChrome(_line: string): ChromeStep | null {
  // Tool-call chrome detection is a follow-up; until we have real
  // fixtures the chrome tracker just gets no-op output. Returning
  // null is the documented default behaviour.
  return null;
}

export function detectCursorSelector(lines: string[]): SelectPrompt | null {
  // Cursor uses the same `❯ N. label` numbered selector style as
  // Claude / Codex when offering multi-choice prompts. Conservative
  // detector: only the last 10 lines (current screen frame) are
  // scanned; option lines that match `N. label` shape are included.
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 10; i--) {
    const pointer = lines[i].match(/❯\s+(\d+)\.\s+(.+)$/);
    if (!pointer) continue;
    const labelRe = /^\s*(?:❯\s+)?(\d+)\.\s+(.+)$/;
    const options: string[] = [];
    for (let j = Math.max(0, i - 8); j <= Math.min(lines.length - 1, i + 8); j++) {
      const lm = lines[j].match(labelRe);
      if (lm) options.push(lm[2].trim());
    }
    if (options.length === 0) return null;
    return {
      question: '',
      options,
      optionDescriptions: options.map(() => ''),
      // The pointer line carries the currently-highlighted option;
      // resolve by index in the assembled list, fall back to 0.
      currentIndex: Math.max(0, options.indexOf(pointer[2].trim())),
    };
  }
  return null;
}

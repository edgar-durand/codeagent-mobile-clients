/**
 * TUI parsing for Aider.
 *
 * Aider has a richer interactive shell than Claude / Codex — it
 * shows file diffs inline, has a `>` prompt for input, and prints
 * tool-call breadcrumbs (`Files added to chat`, `Applied edit to…`,
 * `Committing changes...`). The baseline parsers here strip ANSI +
 * spinner noise and drop the obvious chrome lines so the mobile
 * feed carries the conversation + diffs without per-tool status
 * frames.
 *
 * As with Cursor's parser, fixture-driven refinement is a follow-up
 * — these run-of-the-mill parsers are correct for the obvious
 * cases and conservative on the edge cases (when in doubt, the line
 * passes through to the mobile feed).
 */

import type { ChromeStep, SelectPrompt } from '@codeam/shared';

const ANSI_CSI = /\x1B\[[^@-~]*[@-~]/g;
const SPINNER_GLYPHS = /[⠁⠂⠄⠈⠐⠠⡀⢀⠃⠉⠘⠰⢠⡠⢄⡈⠆⠌⠴⢤⡁⢁⠅⠊⠒⠦⡂]/;

// Lines Aider emits as transient status / tool-call breadcrumbs
// rather than agent prose. Conservative — only the ones we know
// for certain are status frames. Anything else passes through.
const AIDER_CHROME_PATTERNS: RegExp[] = [
  /^Aider v\d+/, // boot banner
  /^Model:\s/, // model echo on boot
  /^Git repo:\s/, // boot
  /^Repo-map:\s/, // boot
  /^Files added to chat:/,
  /^Files removed from chat:/,
  /^Applied edit to /,
  /^Committing changes\.\.\./,
  /^Commit [0-9a-f]{7,}/,
  /^Use \/help/, // tip line
];

export function filterAiderChrome(lines: string[]): string[] {
  return lines.filter((line) => {
    const stripped = line.replace(ANSI_CSI, '').trim();
    if (stripped.length === 0) return false;
    if (SPINNER_GLYPHS.test(stripped)) return false;
    for (const re of AIDER_CHROME_PATTERNS) {
      if (re.test(stripped)) return false;
    }
    return true;
  });
}

export function parseAiderChrome(line: string): ChromeStep | null {
  const stripped = line.replace(ANSI_CSI, '').trim();
  // Surface tool-call breadcrumbs as ChromeStep so the mobile UI
  // can render a progress affordance instead of a raw log line.
  const editMatch = stripped.match(/^Applied edit to (.+)$/);
  if (editMatch) {
    return {
      tool: 'edit',
      label: 'Applied edit',
      detail: editMatch[1],
      status: 'done',
    };
  }
  if (/^Committing changes\.\.\./.test(stripped)) {
    return { tool: 'bash', label: 'git commit', status: 'running' };
  }
  return null;
}

/**
 * Aider doesn't use Ink-style numbered selectors. Its interactive
 * prompts are free-form `>` lines with the user expected to type
 * a response (or `y` / `n` for diff approval). We never return a
 * SelectPrompt for Aider — the mobile UI sees text and the user
 * types back via the normal command relay.
 */
export function detectAiderSelector(_lines: string[]): SelectPrompt | null {
  return null;
}

/**
 * Strip TUI chrome — separators, spinners, status bars, prompts, thinking
 * frames — from rendered screen lines so only actual conversation content
 * remains.
 *
 * Stateful pass so that continuation lines of a user-input echo (lines that
 * follow a `> text` or `❯ text` line without the leading marker) are also
 * removed. The continuation flag resets on any empty line or separator line,
 * which always appears between the user echo and Claude's response in the TUI.
 */
export function filterChrome(lines: string[]): string[] {
  const result: string[] = [];
  let skipEchoContinuation = false;

  for (const line of lines) {
    const t = line.trim();

    if (!t) { skipEchoContinuation = false; continue; }
    if (/^[─━—═─\-]{3,}$/.test(t)) { skipEchoContinuation = false; continue; }

    // Reset on agent-reply prefix. Claude uses `●` (U+25CF BLACK CIRCLE) or
    // `⏺` (U+23FA RECORD BUTTON). Codex uses `·` (U+00B7 MIDDLE DOT) for
    // the same purpose (the bullet that prefixes each agent message line).
    // Without `·` in this set, Codex replies stay marked as user-echo
    // continuation and get filtered out — agent never appears in the
    // mobile feed.
    //
    // These prefixes are a hard signal that the user-echo block is over,
    // even on Windows ConPTY where the reply often lands on the very
    // next line with no blank separator. Without this reset, the echo
    // continuation flag swallows the first response line and the
    // mobile/web client sees nothing for the entire turn. Mac doesn't
    // hit this because its output usually has a blank line between
    // the echo and the reply, which already resets the flag above.
    if (/^[●⏺·]\s/.test(t)) skipEchoContinuation = false;

    if (/^[✳✢✶✻✽✴✷✸✹⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓▁▂▃▄▅▆▇█]\s/.test(t)) continue;
    if (/esc.{0,5}to.{0,5}interrupt/i.test(t)) continue;
    if (/high\s*[·•]\s*\/effort/i.test(t)) continue;

    if (/^[❯>]\s*$/.test(t)) continue;
    if (/^\(thinking\)\s*$/.test(t)) continue;
    if (/^\?\s.*shortcut/i.test(t)) continue;
    if (/spending limit|usage limit/i.test(t) && t.length < 80) continue;
    if (/↑\s*\/?\s*↓\s*to\s*navigate/i.test(t)) continue;

    // A single visible character is never real content (e.g. status-bar leak).
    if (t.replace(/\s/g, '').length === 1) continue;

    // Status/progress filler — 6+ `─` chars.
    if ((t.match(/─/g)?.length ?? 0) >= 6) continue;

    if (/ctrl\+?o\s+to\s+expand/i.test(t)) continue;

    // Bullet-prefixed tool-use lines (Claude Code TUI v4+). Only known tool
    // verbs so we don't clobber bullets that appear inside Claude's responses.
    if (
      /^•\s+(?:Read(?:ing)?|Edit(?:ing)?|Writ(?:e|ing)|Bash|Runn(?:ing)?|Search(?:ing)?|Glob(?:bing)?|Grep(?:ping)?|Creat(?:e|ing)|Execut(?:e|ing)|Task|Agent|NotebookEdit)\b/i.test(
        t,
      )
    )
      continue;

    if (/^└\s/.test(t)) continue;
    if (/^\+\s/.test(t) && /\d+\s*s\s*[·•]|\bthought\s+for\b|\d+\s*tokens|\(thinking\)/i.test(t)) continue;
    if (/^↓\s*\d+\s*tokens/i.test(t)) continue;
    if (/^\bthought\s+for\s+\d+/i.test(t)) continue;

    // User input echo (`> text` / `❯ text`), including box-bordered variants
    // like `│ ❯ text`. Mark subsequent lines as continuations to filter too.
    const stripped = t.replace(/^[│╭╰╮╯┌└┐┘├┤┬┴┼]\s?/, '');
    if (/^[❯>]\s+\S/.test(stripped) && !/^[❯>]\s*\d+\./.test(stripped)) {
      skipEchoContinuation = true;
      continue;
    }

    if (skipEchoContinuation) continue;

    result.push(line);
  }

  return result;
}

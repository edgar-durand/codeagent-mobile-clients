// Mirrors packages/shared/src/types/api.ts — keep in sync manually.
// The CLI is a standalone npm package and cannot import from packages/shared.
type ChromeToolType = 'read' | 'edit' | 'bash' | 'search' | 'thinking' | 'other';

export interface ChromeStep {
  tool: ChromeToolType;
  label: string; // file path, command, query, or "Thinking…"
  detail?: string; // e.g. "312 lines", "2 tool uses"
  status: 'running' | 'done';
}

// Spinner characters used by Claude Code's older TUI (mirrors filterChrome in output.service.ts)
const SPINNER_RE = /^[✳✢✶✻✽✴✷✸✹⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓▁▂▃▄▅▆▇█]\s/;

// New Claude Code TUI format (v4+)
const BULLET_TOOL_RE =
  /^•\s+(?:Read(?:ing)?|Edit(?:ing)?|Writ(?:e|ing)|Bash|Runn(?:ing)?|Search(?:ing)?|Glob(?:bing)?|Grep(?:ping)?|Creat(?:e|ing)|Execut(?:e|ing)|Task|Agent|NotebookEdit)\b/i;
const TREE_LINE_RE = /^└\s/;
const STATUS_LINE_RE = /^\+\s/;

/**
 * Returns true if a line would be filtered by filterChrome() in output.service.ts.
 * This is the inverse predicate — used to capture chrome lines before they are discarded.
 */
export function isChromeLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^[─━—═─\-]{3,}$/.test(t)) return true;
  if (SPINNER_RE.test(t)) return true;
  if (BULLET_TOOL_RE.test(t)) return true;
  if (TREE_LINE_RE.test(t)) return true;
  if (STATUS_LINE_RE.test(t) && /\d+\s*s\s*[·•]|\bthought\s+for\b|\d+\s*tokens|\(thinking\)/i.test(t)) return true;
  if (/^↓\s*\d+\s*tokens/i.test(t)) return true;
  if (/^\bthought\s+for\s+\d+/i.test(t)) return true;
  if (/esc.{0,5}to.{0,5}interrupt/i.test(t)) return true;
  if (/high\s*[·•]\s*\/effort/i.test(t)) return true;
  if (/^[❯>]\s*$/.test(t)) return true;
  if (/^\(thinking\)\s*$/.test(t)) return true;
  if (/^\?\s.*shortcut/i.test(t)) return true;
  if (/spending limit|usage limit/i.test(t) && t.length < 80) return true;
  if (/↑\s*\/?\s*↓\s*to\s*navigate/i.test(t)) return true;
  if (t.replace(/\s/g, '').length === 1) return true;
  if ((t.match(/─/g)?.length ?? 0) >= 6) return true;
  if (/ctrl\+?o\s+to\s+expand/i.test(t)) return true;
  // Only capture ❯/> command lines when they appear INSIDE a box (╰ > git status).
  // Bare "> user typed text" lines must NOT be captured — they are echoed terminal input.
  const hasBoxPrefix = /^[│╭╰╮╯┌└┐┘├┤┬┴┼]/.test(t);
  const stripped = t.replace(/^[│╭╰╮╯┌└┐┘├┤┬┴┼]\s?/, '');
  if (hasBoxPrefix && /^[❯>]\s+\S/.test(stripped) && !/^[❯>]\s*\d+\./.test(stripped)) return true;
  return false;
}

/**
 * Converts a chrome line into a structured ChromeStep.
 * Returns null for lines that are structural (separators, bare prompts) and carry no useful info.
 */
export function parseChromeLine(line: string): ChromeStep | null {
  const t = line.trim();
  if (!t) return null;

  // Separator lines — no useful info
  if (/^[─━—═─\-]{3,}$/.test(t)) return null;
  // Bare prompt — no useful info
  if (/^[❯>]\s*$/.test(t)) return null;
  // Single visible char — no useful info
  if (t.replace(/\s/g, '').length === 1) return null;
  // Lines with 6+ box-drawing dashes
  if ((t.match(/─/g)?.length ?? 0) >= 6) return null;

  // Noise-only lines — no actionable step info
  if (/esc.{0,5}to.{0,5}interrupt/i.test(t)) return null;
  if (/high\s*[·•]\s*\/effort/i.test(t)) return null;
  if (/↑\s*\/?\s*↓\s*to\s*navigate/i.test(t)) return null;
  if (/ctrl\+?o\s+to\s+expand/i.test(t)) return null;
  if (/spending limit|usage limit/i.test(t)) return null;

  // (thinking) lines
  if (/^\(thinking\)\s*$/.test(t)) {
    return { tool: 'thinking', label: 'Thinking…', status: 'running' };
  }

  // Tree connector lines (└) — sub-items carry detail but no standalone step info
  if (TREE_LINE_RE.test(t)) return null;

  // Status/thinking lines: "+ Puttering… (22s · ↑ 102 tokens · thought for 15s)"
  // Strip everything from the ellipsis onwards — the verb before "…" is the only stable
  // identifier. Handles all formats: "(Ns)", "(Nm Ns · ↓ tokens)", bare "7", partial "3 11s…"
  if (STATUS_LINE_RE.test(t)) {
    const label = t
      .slice(2) // strip '+ '
      .replace(/….*/s, '') // strip "…" and everything after (time counters, tokens, etc.)
      .trim() || 'Thinking…';
    return { tool: 'thinking', label, status: 'running' };
  }

  // Strip prefix to get the action text:
  //   • old format: spinner char (1 char) + space
  //   • new format: "• " (bullet U+2022 + space)
  let text = t;
  if (SPINNER_RE.test(t)) {
    // Strip spinner char + space, then remove everything from "…" onwards so that
    // "Cultivating… 7", "Cultivating… (3m 11s · ↓ 256 tokens)", and
    // "Cultivating… 3 11s · ↓ 256 tokens)" all deduplicate to "Cultivating".
    text = t.slice(2).trim()
      .replace(/….*/s, '') // strip from … onwards (time counters, tokens, etc.)
      .trim();
  } else if (BULLET_TOOL_RE.test(t)) {
    text = t.slice(2).trim(); // strip "• "
    // Remove trailing " (ctrl+o to expand)", ", reading N file(s)…" noise
    text = text
      .replace(/\s*\(ctrl\+?o[^)]*\)/gi, '')
      .replace(/,\s*reading\s+\d+\s+files?\s*…?/gi, '')
      .replace(/,\s*\d+\s+files?\s*…?/gi, '')
      .replace(/…$/, '')
      .trim();
  }

  if (!text) return null;

  return classifyStep(text);
}

function classifyStep(text: string): ChromeStep {
  // Read patterns
  if (/^Read(?:ing)?\s+/i.test(text)) {
    const label = text
      .replace(/^Read(?:ing)?\s+/i, '')
      .replace(/\.\.\.$/, '')
      .trim();
    return { tool: 'read', label, status: 'running' };
  }

  // Edit / Write patterns
  if (/^Edit(?:ing)?\s+|^Writ(?:e|ing|ing to)\s+|^Creat(?:e|ing)\s+/i.test(text)) {
    const label = text
      .replace(/^(?:Edit(?:ing)?|Writ(?:e|ing(?: to)?)|Creat(?:e|ing))\s+/i, '')
      .replace(/\.\.\.$/, '')
      .trim();
    return { tool: 'edit', label, status: 'running' };
  }

  // Bash / Run patterns
  if (/^Runn(?:ing)?\s+|^Execut(?:e|ing)\s+|^Bash(?:ing)?\s*:|^\$\s+/i.test(text)) {
    const label = text
      .replace(/^(?:Runn(?:ing)?|Execut(?:e|ing)|Bash(?:ing)?:|\$)\s+/i, '')
      .replace(/\.\.\.$/, '')
      .trim();
    return { tool: 'bash', label, status: 'running' };
  }

  // Search patterns
  if (/^Search(?:ing)?\s+for\s+|^Grep(?:ping)?\s*:/i.test(text)) {
    const label = text
      .replace(/^(?:Search(?:ing)?\s+for|Grep(?:ping)?:)\s+/i, '')
      .replace(/\.\.\.$/, '')
      .trim();
    return { tool: 'search', label, status: 'running' };
  }

  // Fallback: keep text as label
  const label = text.replace(/\.\.\.$/, '').trim();
  return { tool: 'other', label, status: 'running' };
}

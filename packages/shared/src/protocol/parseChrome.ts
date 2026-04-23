type ChromeToolType = 'read' | 'edit' | 'bash' | 'search' | 'thinking' | 'other';

export interface ChromeStep {
  tool: ChromeToolType;
  label: string;
  detail?: string;
  status: 'running' | 'done';
}

const SPINNER_RE = /^[✳✢✶✻✽✴✷✸✹⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓▁▂▃▄▅▆▇█]\s/;

const BULLET_TOOL_RE =
  /^•\s+(?:Read(?:ing)?|Edit(?:ing)?|Writ(?:e|ing)|Bash|Runn(?:ing)?|Search(?:ing)?|Glob(?:bing)?|Grep(?:ping)?|Creat(?:e|ing)|Execut(?:e|ing)|Task|Agent|NotebookEdit)\b/i;
const TREE_LINE_RE = /^└\s/;
const STATUS_LINE_RE = /^\+\s/;

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
  const hasBoxPrefix = /^[│╭╰╮╯┌└┐┘├┤┬┴┼]/.test(t);
  const stripped = t.replace(/^[│╭╰╮╯┌└┐┘├┤┬┴┼]\s?/, '');
  if (hasBoxPrefix && /^[❯>]\s+\S/.test(stripped) && !/^[❯>]\s*\d+\./.test(stripped)) return true;
  return false;
}

export function parseChromeLine(line: string): ChromeStep | null {
  const t = line.trim();
  if (!t) return null;

  if (/^[─━—═─\-]{3,}$/.test(t)) return null;
  if (/^[❯>]\s*$/.test(t)) return null;
  if (t.replace(/\s/g, '').length === 1) return null;
  if ((t.match(/─/g)?.length ?? 0) >= 6) return null;

  if (/esc.{0,5}to.{0,5}interrupt/i.test(t)) return null;
  if (/high\s*[·•]\s*\/effort/i.test(t)) return null;
  if (/↑\s*\/?\s*↓\s*to\s*navigate/i.test(t)) return null;
  if (/ctrl\+?o\s+to\s+expand/i.test(t)) return null;
  if (/spending limit|usage limit/i.test(t)) return null;

  if (/^\(thinking\)\s*$/.test(t)) {
    return { tool: 'thinking', label: 'Thinking…', status: 'running' };
  }

  if (TREE_LINE_RE.test(t)) return null;

  // Status/thinking line shape: "+ Puttering… (22s · ↑ 102 tokens · thought for 15s)".
  // The verb before "…" is the only stable identifier; everything after is noise that
  // changes every frame and would break dedup.
  if (STATUS_LINE_RE.test(t)) {
    const label = t
      .slice(2)
      .replace(/….*/s, '')
      .trim() || 'Thinking…';
    return { tool: 'thinking', label, status: 'running' };
  }

  let text = t;
  if (SPINNER_RE.test(t)) {
    text = t.slice(2).trim()
      .replace(/….*/s, '')
      .trim();
  } else if (BULLET_TOOL_RE.test(t)) {
    text = t.slice(2).trim();
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
  if (/^Read(?:ing)?\s+/i.test(text)) {
    const label = text
      .replace(/^Read(?:ing)?\s+/i, '')
      .replace(/\.\.\.$/, '')
      .trim();
    return { tool: 'read', label, status: 'running' };
  }

  if (/^Edit(?:ing)?\s+|^Writ(?:e|ing|ing to)\s+|^Creat(?:e|ing)\s+/i.test(text)) {
    const label = text
      .replace(/^(?:Edit(?:ing)?|Writ(?:e|ing(?: to)?)|Creat(?:e|ing))\s+/i, '')
      .replace(/\.\.\.$/, '')
      .trim();
    return { tool: 'edit', label, status: 'running' };
  }

  if (/^Runn(?:ing)?\s+|^Execut(?:e|ing)\s+|^Bash(?:ing)?\s*:|^\$\s+/i.test(text)) {
    const label = text
      .replace(/^(?:Runn(?:ing)?|Execut(?:e|ing)|Bash(?:ing)?:|\$)\s+/i, '')
      .replace(/\.\.\.$/, '')
      .trim();
    return { tool: 'bash', label, status: 'running' };
  }

  if (/^Search(?:ing)?\s+for\s+|^Grep(?:ping)?\s*:/i.test(text)) {
    const label = text
      .replace(/^(?:Search(?:ing)?\s+for|Grep(?:ping)?:)\s+/i, '')
      .replace(/\.\.\.$/, '')
      .trim();
    return { tool: 'search', label, status: 'running' };
  }

  const label = text.replace(/\.\.\.$/, '').trim();
  return { tool: 'other', label, status: 'running' };
}

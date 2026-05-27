/**
 * Claude-specific TUI parsers.
 *
 * Moved verbatim from @codeagent/shared's protocol/{filterChrome,parseChrome,
 * selector}.ts. The logic is exactly what shipped for every prior Claude
 * release — no behavioral changes. It lives here because each agent's TUI
 * conventions are different (glyphs, selector shapes, status-line formats),
 * so the parsers belong next to the agent's RuntimeStrategy rather than in
 * the cross-agent shared package.
 *
 * Codex's parsers live at apps/cli/src/agents/codex/parsing.ts.
 */

import type { ChromeStep, SelectPrompt } from '@codeagent/shared';
import type { StartupBanner } from '../strategy';

// ─── filterChrome ──────────────────────────────────────────────────

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

    // Claude's reply always starts with `● ` (U+25CF) or `⏺ ` (U+23FA)
    // — that prefix is a hard signal that the user-echo block is over,
    // even on Windows ConPTY where the reply often lands on the very
    // next line with no blank separator. Without this reset, the echo
    // continuation flag swallows Claude's first response line and the
    // mobile/web client sees nothing for the entire turn. Mac doesn't
    // hit this because its output usually has a blank line between
    // the echo and the reply, which already resets the flag above.
    if (/^[●⏺]\s/.test(t)) skipEchoContinuation = false;

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

// ─── parseChrome (isChromeLine / parseChromeLine) ──────────────────

// Spinner glyphs Claude Code cycles through during the "thinking"
// animation. Includes the original ASCII / Unicode set AND the newer
// colored-circle emoji set the v2.1+ TUI introduced — without these
// the status/spinner line leaks into the conversation as plain text
// and the chat shows duplicated "Symbioting…" / "Boondoggling…"
// lines once per CLI tick. Variation Selector-16 (U+FE0F) is
// stripped before the test so we don't have to enumerate both forms.
const SPINNER_RE =
  /^(?:[✳✢✶✻✽✴✷✸✹⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓▁▂▃▄▅▆▇█]|🔴|🟠|🟡|🟢|🔵|🟣|🟤|⚫|⚪|🌀|💭|✨)\s/u;

const BULLET_TOOL_RE =
  /^•\s+(?:Read(?:ing)?|Edit(?:ing)?|Writ(?:e|ing)|Bash|Runn(?:ing)?|Search(?:ing)?|Glob(?:bing)?|Grep(?:ping)?|Creat(?:e|ing)|Execut(?:e|ing)|Task|Agent|NotebookEdit)\b/i;
const TREE_LINE_RE = /^└\s/;
// Status line: legacy "+ Symbioting…" or new emoji-prefixed
// "🔵 Symbioting…". Both end in a status detail like "(8s · ↓ 620
// tokens)" which the existing tests downstream still match against.
const STATUS_LINE_RE =
  /^(?:\+|[🔴🟠🟡🟢🔵🟣🟤⚫⚪🌀💭✨])\s/u;

export function isChromeLine(line: string): boolean {
  // Strip the U+FE0F variation selector that often follows emoji so
  // the regexes match both presentations of the colored-circle
  // spinner glyphs.
  const t = line.replace(/️/g, '').trim();
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
  const t = line.replace(/️/g, '').trim();
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

// ─── selector (detectSelector / detectListSelector) ────────────────

/**
 * Detect a numbered interactive selector — `❯ 1. Label` style — in the
 * already-rendered screen lines.
 *
 * Input must come from {@link renderToLines}: clean text with no ANSI codes,
 * so cursor-overwrite artifacts ("❯ 1. Label" built from `  1. Label\r❯`)
 * have already collapsed onto one line.
 *
 * Guards against false positives where Claude's own response contains a
 * numbered list while the input cursor (❯) sits elsewhere on screen. Also
 * short-circuits when the idle input hint (`? for shortcuts`) is visible,
 * which means the regular input field is active and no selector is live.
 */
export function detectSelector(lines: string[]): SelectPrompt | null {
  if (lines.some(l => /\?\s+for\s+shortcuts/i.test(l.trim()))) return null;

  // Strip box-border chars from line edges so that numbered selectors rendered
  // inside a bordered panel (e.g. /mcp server detail view) are still detected.
  const clean = lines.map(l =>
    l
      .replace(/^[│╭╰╮╯┌└┐┘├┤┬┴┼]\s?/, '')
      .replace(/\s*[│╭╰╮╯┌└┐┘├┤┬┴┼─━═]+\s*$/, ''),
  );

  // Accept both `❯` (the canonical React Ink arrow) and the bare
  // `>` that Windows ConPTY emits for the same glyph when the
  // terminal font lacks U+276F. Both render as the selector cursor.
  // Anchor on the cursor presence OR a trust-dialog signature so a
  // PTY rendering pass that ate the cursor (Windows font fallback,
  // partial frame) still surfaces the selector.
  const hasCursor = clean.some(l => /^[❯>]\s*\d+\./.test(l.trim()));
  // First-run "Do you trust this folder?" dialog is the most
  // recognisable case where the cursor character can disappear
  // through the rendering pipeline. Match the question phrasing so
  // we lock onto it whether or not `❯`/`>` survived.
  const looksLikeTrust = clean.some(l =>
    /\b(?:trust\s+the\s+files|trust\s+this\s+folder|safety\s+check)\b/i.test(l),
  );
  if (!hasCursor && !looksLikeTrust) return null;

  let optionStartIdx = -1;
  for (let i = 0; i < clean.length; i++) {
    if (/^(?:[❯>]\s*)?\d+\.\s/.test(clean[i].trim())) { optionStartIdx = i; break; }
  }
  if (optionStartIdx === -1) return null;

  const questionParts: string[] = [];
  for (let i = 0; i < optionStartIdx; i++) {
    const t = clean[i].trim();
    if (!t) continue;
    if (/^[─━—═\-]{3,}$/.test(t)) continue;
    if (/^\[.*\]$/.test(t)) continue;
    if (/^[>❯]\s/.test(t)) continue;
    // PTY overwrite artifact — no spaces + long (e.g. "needsvauthenticationhentication")
    if (!t.includes(' ') && t.length > 15) continue;
    questionParts.push(t);
  }
  const question = questionParts
    .filter((line, i, arr) => !arr.some((other, j) => j !== i && other.includes(line)))
    .join('\n')
    .trim();

  const optionLabels = new Map<number, string>();
  const optionDescs = new Map<number, string[]>();
  let currentNum = -1;

  for (let i = optionStartIdx; i < clean.length; i++) {
    const t = clean[i].trim();
    if (!t) continue;

    const m = t.match(/^(?:[❯>]\s*)?(\d+)\.\s+(.+)/);
    if (m) {
      const num = parseInt(m[1], 10);
      if (!optionLabels.has(num)) {
        optionLabels.set(num, m[2].trim());
        optionDescs.set(num, []);
      }
      currentNum = num;
    } else if (
      currentNum !== -1 &&
      !/^Enter to/i.test(t) &&
      !/^[─━—═\-]{3,}$/.test(t) &&
      !/↑.*↓.*navigate/i.test(t) &&
      !/Esc to/i.test(t)
    ) {
      optionDescs.get(currentNum)?.push(t);
    }
  }

  const keys = [...optionLabels.keys()].sort((a, b) => a - b);
  if (keys.length < 2 || keys[0] !== 1) return null;

  return {
    question,
    options: keys.map(k => optionLabels.get(k)!),
    optionDescriptions: keys.map(k => (optionDescs.get(k) ?? []).join(' ').trim()),
    currentIndex: 0,
  };
}

/**
 * Detect a list-style selector — `/mcp`, `/model` — where the highlighted
 * item is prefixed with `  ❯ ` instead of `❯ N.`.
 *
 * Returns `currentIndex` (0-based position of ❯) so the client can send
 * bidirectional arrow navigation rather than always starting from index 0.
 */
export function detectListSelector(lines: string[]): SelectPrompt | null {
  if (!lines.some(l => /[↑↓].*navigate/i.test(l.trim()))) return null;
  if (lines.some(l => /^❯\s*\d+\./.test(l.trim()))) return null;
  if (!lines.some(l => /^\s+❯\s+\S/.test(l))) return null;

  const isSelected   = (line: string): boolean => /^\s+❯\s+\S/.test(line);
  const isUnselected = (line: string): boolean => /^    \S/.test(line);
  const isItem       = (line: string): boolean => isSelected(line) || isUnselected(line);

  let optionStartIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isItem(lines[i])) { optionStartIdx = i; break; }
  }
  if (optionStartIdx === -1) return null;

  const questionParts: string[] = [];
  for (let i = 0; i < optionStartIdx; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^[─━—═\-]{3,}$/.test(t)) continue;
    if (/[┌└│┐┘├┤┬┴┼]/.test(t)) {
      const inner = t.replace(/[│┌└┐┘├┤┬┴┼─]/g, '').trim();
      if (inner) questionParts.push(inner);
      continue;
    }
    if (/^[>❯]\s/.test(t)) continue;
    if (/[↑↓].*navigate/i.test(t)) continue;
    if (!t.includes(' ') && t.length > 15) continue;
    questionParts.push(t);
  }
  const question = questionParts
    .filter((line, i, arr) => !arr.some((other, j) => j !== i && other.includes(line)))
    .join('\n')
    .trim();

  const options: string[] = [];
  let currentIndex = 0;

  for (const line of lines.slice(optionStartIdx)) {
    const t = line.trim();
    if (!t) continue;
    if (/[↑↓].*navigate/i.test(t)) break;
    if (/^[─━—═\-]{3,}$/.test(t)) continue;

    if (isSelected(line)) {
      currentIndex = options.length;
      options.push(t.replace(/^❯\s+/, '').trim());
    } else if (isUnselected(line)) {
      options.push(t);
    }
  }

  if (options.length < 2) return null;

  return {
    question,
    options,
    optionDescriptions: options.map(() => ''),
    currentIndex,
  };
}

// ─── detectStartupBanner ───────────────────────────────────────────

// Block-art glyphs the Claude Code splash uses. Covers both the legacy
// 3-line quadrant set (`▐▛█▜▌▝▘`) and the wider v2.x rectangle / shade
// set the new CLAUDE letterforms ship with.
const BANNER_ART_RE = /[█▀▄▌▐▝▘▛▜▙▟▖▗▔▕▮▯▰▱▓▒░◆◇]/;

// "Sonnet 4.6 · Claude API", "Opus 4.7 · API Console", "Claude Code"
// — metadata line that always sits beneath the art row(s).
const BANNER_META_RE = /(?:Sonnet|Opus|Haiku|Claude)(?:\s|·|-|\(|$)/i;

/**
 * Detect Claude Code's startup banner in rendered TUI lines. Two
 * formats are supported because the CLI shipped a major banner rev
 * mid-v2:
 *
 *   1. **Legacy 3-line** — `▐▛███▜▌` / `▝▜███▛▘` / `▘▘ <path>`.
 *      Title and subtitle live INSIDE the first two art rows.
 *
 *   2. **v2.x multi-row** — ≥2 contiguous block-art lines (the
 *      stylised CLAUDE letterforms) followed by a metadata line
 *      ("Sonnet 4.6 · Claude API") and a path line. No title is
 *      embedded in the art so the chunk carries an empty `title`
 *      and the UI falls back to the agent's product name.
 *
 * Returns the parsed banner + the inclusive index range it covers,
 * so {@link OutputService} can slice it out of the rendered line
 * array before the chrome filter + text emit. Returns `null` when
 * no banner is visible in this tick.
 */
export function detectStartupBanner(lines: string[]): StartupBanner | null {
  // ── Legacy 3-line format ─────────────────────────────────────────
  // The art glyph triple can live anywhere on the line — Claude v2.1.x
  // renders the same 3-line banner INSIDE a two-column box-drawn
  // frame ("│  ...  ▐▛███▜▌  ...  │ Tips for getting started"), so
  // start-of-line anchors silently miss every v2.1.x welcome. The
  // glyph triple itself is unique enough to avoid false positives
  // without anchoring.
  for (let i = 0; i + 2 < lines.length; i++) {
    if (!/▐▛[█]+▜▌/.test(lines[i])) continue;
    if (!/▝▜[█]+▛▘/.test(lines[i + 1])) continue;
    if (!lines[i + 2].includes('▘▘')) continue;
    // Title / subtitle / path live OUTSIDE the art lines in v2.1.x —
    // "Welcome back Edgar!" sits on the row above the art and the
    // meta/cwd sit below. When the art is indented inside a frame,
    // the legacy in-art extraction yields empty strings; that's the
    // signal to the renderer that the surface-side banner card
    // should fall back to its agent product name. Keep the
    // in-art extraction for the unframed case (still common when
    // claude is invoked via headless / sandbox flows without a
    // top-of-window banner box).
    const inArtTitle = lines[i].replace(/^▐▛[█]+▜▌\s*/, '').trim();
    const inArtSubtitle = lines[i + 1].replace(/^▝▜[█]+▛▘\s*/, '').trim();
    const inArtPath = lines[i + 2].replace(/.*▝▝\s*/, '').trim();
    return {
      title: inArtTitle === lines[i].trim() ? '' : inArtTitle,
      subtitle: inArtSubtitle === lines[i + 1].trim() ? '' : inArtSubtitle,
      path: inArtPath === lines[i + 2].trim() ? '' : inArtPath,
      startIdx: i,
      endIdx: i + 2,
    };
  }

  // ── v2.x multi-row format ────────────────────────────────────────
  // Find a metadata line first; walk up to count contiguous art rows.
  // Need ≥2 art rows to reject false matches on inline diff glyphs.
  const metaIdx = lines.findIndex(
    (l) =>
      BANNER_META_RE.test(l) &&
      /(?:Claude|API|Console)/i.test(l) &&
      !BANNER_ART_RE.test(l),
  );
  if (metaIdx === -1) return null;

  let artStart = metaIdx;
  while (artStart > 0 && BANNER_ART_RE.test(lines[artStart - 1])) artStart--;
  if (metaIdx - artStart < 2) return null;

  const pathLine = (lines[metaIdx + 1] ?? '').trim();
  const path = pathLine && !BANNER_ART_RE.test(pathLine) ? pathLine : '';

  return {
    title: '',
    subtitle: lines[metaIdx].trim(),
    path,
    startIdx: artStart,
    endIdx: metaIdx + (path ? 1 : 0),
  };
}

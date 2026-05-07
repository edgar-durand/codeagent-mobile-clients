export interface SelectPrompt {
  question: string;
  options: string[];
  optionDescriptions: string[];
  /** 0-based index of the highlighted item (always 0 for numbered selectors). */
  currentIndex: number;
}

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
  if (!clean.some(l => /^[❯>]\s*\d+\./.test(l.trim()))) return null;

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

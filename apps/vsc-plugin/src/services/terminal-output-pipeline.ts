// Terminal output pipeline ported from apps/cli/src/services/output.service.ts.
// Kept as pure functions so the VS Code extension can process raw terminal
// output captured via shell integration the same way codeam-cli processes
// raw PTY output. Keeping these in sync means the mobile/web client sees
// identical SSE chunks regardless of which surface is running Claude Code.

/** Virtual terminal: render raw bytes (with ANSI escapes) into screen lines. */
export function renderToLines(raw: string): string[] {
  const screen: string[] = [''];
  let row = 0;
  let col = 0;

  function ensureRow(): void {
    while (screen.length <= row) screen.push('');
  }

  function writeChar(ch: string): void {
    ensureRow();
    if (col < screen[row].length) {
      screen[row] = screen[row].slice(0, col) + ch + screen[row].slice(col + 1);
    } else {
      while (screen[row].length < col) screen[row] += ' ';
      screen[row] += ch;
    }
    col++;
  }

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '\x1B') {
      i++;
      if (i >= raw.length) break;

      if (raw[i] === '[') {
        i++;
        let param = '';
        while (i < raw.length && !/[@-~]/.test(raw[i])) param += raw[i++];
        const cmd = raw[i] ?? '';
        const n = parseInt(param) || 1;

        if      (cmd === 'A') { row = Math.max(0, row - n); }
        else if (cmd === 'B') { row += n; ensureRow(); }
        else if (cmd === 'C') { col += n; }
        else if (cmd === 'D') { col = Math.max(0, col - n); }
        else if (cmd === 'G') { col = Math.max(0, n - 1); }
        else if (cmd === 'H' || cmd === 'f') {
          const p = param.split(';');
          row = Math.max(0, (parseInt(p[0] ?? '1') || 1) - 1);
          col = Math.max(0, (parseInt(p[1] ?? '1') || 1) - 1);
          ensureRow();
        } else if (cmd === 'J') {
          if (param === '2' || param === '3') {
            screen.length = 1; screen[0] = ''; row = 0; col = 0;
          } else if (param === '1') {
            for (let r = 0; r < row; r++) screen[r] = '';
            screen[row] = ' '.repeat(col) + screen[row].slice(col);
          } else {
            screen[row] = screen[row].slice(0, col);
            screen.splice(row + 1);
          }
        } else if (cmd === 'K') {
          ensureRow();
          if      (param === '' || param === '0') screen[row] = screen[row].slice(0, col);
          else if (param === '1') screen[row] = ' '.repeat(col) + screen[row].slice(col);
          else if (param === '2') screen[row] = '';
        } else if (cmd === 'h' && (param === '?1049' || param === '?47')) {
          screen.length = 1; screen[0] = ''; row = 0; col = 0;
        } else if (cmd === 'l' && (param === '?1049' || param === '?47')) {
          screen.length = 1; screen[0] = ''; row = 0; col = 0;
        }
      } else if (raw[i] === ']') {
        i++;
        while (i < raw.length) {
          if (raw[i] === '\x07') break;
          if (raw[i] === '\x1B' && i + 1 < raw.length && raw[i + 1] === '\\') { i++; break; }
          i++;
        }
      }
    } else if (ch === '\r') {
      if (i + 1 < raw.length && raw[i + 1] === '\n') {
        row++; col = 0; ensureRow(); i++;
      } else {
        col = 0;
      }
    } else if (ch === '\n') {
      row++; col = 0; ensureRow();
    } else if (ch >= ' ' || ch === '\t') {
      writeChar(ch);
    }

    i++;
  }

  return screen;
}

export interface SelectPrompt {
  question: string;
  options: string[];
  optionDescriptions: string[];
  currentIndex: number;
}

export function detectSelector(lines: string[]): SelectPrompt | null {
  if (lines.some(l => /\?\s+for\s+shortcuts/i.test(l.trim()))) return null;

  const clean = lines.map(l =>
    l
      .replace(/^[│╭╰╮╯┌└┐┘├┤┬┴┼]\s?/, '')
      .replace(/\s*[│╭╰╮╯┌└┐┘├┤┬┴┼─━═]+\s*$/, '')
  );

  if (!clean.some(l => /^❯\s*\d+\./.test(l.trim()))) return null;

  let optionStartIdx = -1;
  for (let i = 0; i < clean.length; i++) {
    if (/^(?:❯\s*)?\d+\.\s/.test(clean[i].trim())) { optionStartIdx = i; break; }
  }
  if (optionStartIdx === -1) return null;

  const questionParts: string[] = [];
  for (let i = 0; i < optionStartIdx; i++) {
    const t = clean[i].trim();
    if (!t) continue;
    if (/^[─━—═\-]{3,}$/.test(t)) continue;
    if (/^\[.*\]$/.test(t)) continue;
    if (/^[>❯]\s/.test(t)) continue;
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

    const m = t.match(/^(?:❯\s*)?(\d+)\.\s+(.+)/);
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

export function detectListSelector(lines: string[]): SelectPrompt | null {
  if (!lines.some(l => /[↑↓].*navigate/i.test(l.trim()))) return null;
  if (lines.some(l => /^❯\s*\d+\./.test(l.trim()))) return null;
  if (!lines.some(l => /^\s+❯\s+\S/.test(l))) return null;

  const isSelected   = (line: string) => /^\s+❯\s+\S/.test(line);
  const isUnselected = (line: string) => /^    \S/.test(line);
  const isItem       = (line: string) => isSelected(line) || isUnselected(line);

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

/** Remove TUI chrome: separators, spinners, status bar, prompts, thinking frames. */
export function filterChrome(lines: string[]): string[] {
  const result: string[] = [];
  let skipEchoContinuation = false;

  for (const line of lines) {
    const t = line.trim();

    if (!t) { skipEchoContinuation = false; continue; }
    if (/^[─━—═─\-]{3,}$/.test(t)) { skipEchoContinuation = false; continue; }

    if (/^[✳✢✶✻✽✴✷✸✹⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓▁▂▃▄▅▆▇█]\s/.test(t)) continue;
    if (/esc.{0,5}to.{0,5}interrupt/i.test(t)) continue;
    if (/high\s*[·•]\s*\/effort/i.test(t)) continue;

    if (/^[❯>]\s*$/.test(t)) continue;
    if (/^\(thinking\)\s*$/.test(t)) continue;
    if (/^\?\s.*shortcut/i.test(t)) continue;
    if (/spending limit|usage limit/i.test(t) && t.length < 80) continue;
    if (/↑\s*\/?\s*↓\s*to\s*navigate/i.test(t)) continue;

    if (t.replace(/\s/g, '').length === 1) continue;
    if ((t.match(/─/g)?.length ?? 0) >= 6) continue;
    if (/ctrl\+?o\s+to\s+expand/i.test(t)) continue;

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

    const stripped = t.replace(/^[│╭╰╮╯┌└┐┘├┤┬┴┼]\s?/, '');
    if (/^[❯>]\s+\S/.test(stripped) && !/^[❯>]\s*\d+\./.test(stripped)) {
      skipEchoContinuation = true;
      continue;
    }

    if (skipEchoContinuation) continue;

    result.push(line);
  }

  // Post-pass: strip the `│ ... │` box wrapper from lines that carry
  // Claude Code's pixel-logo characters, so the mobile client's
  // `parseClaudeStartup` regex anchors correctly on `^▐▛[█]+▜▌` and
  // can replace the 3-line banner with a pre-drawn Claude icon.
  return result.map((line) => {
    if (!/[▐▛▜▌▝▘]/.test(line)) return line;
    return line
      .replace(/^\s*[│╭╰]\s+/, '')
      .replace(/\s+[│╭╰]\s*$/, '')
      .trimStart();
  });
}

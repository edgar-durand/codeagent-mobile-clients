/**
 * Render raw PTY bytes into an array of screen lines using a simplified
 * virtual terminal. Handles cursor movements (A/B/C/D/G/H), erase (J/K),
 * alternate-screen (?1049h/l, ?47h/l), carriage return, and LF.
 *
 * Maintains a `scrollback` buffer in addition to the visible screen so
 * that content written while toggling in and out of alt-screen mode is
 * not lost. This matters for Codex (and any TUI that prints chat
 * history to normal terminal between input-box redraws via alt-screen
 * toggles) — the previous version cleared the screen on every toggle
 * and silently dropped everything written between two toggles, leaving
 * the mobile feed showing only the first line of multi-paragraph
 * replies. Claude's React Ink TUI enters alt-screen once at startup
 * and never toggles, so it's unaffected: the scrollback stays empty
 * (a single empty string at index 0 gets dropped at return time) and
 * the returned lines are identical to the previous implementation.
 *
 * This is the authoritative implementation used by both codeam-cli (PTY
 * output) and the VS Code extension (shell-integration output) so that
 * the mobile/web client sees identical chunks regardless of surface.
 */
export function renderToLines(raw: string): string[] {
  // Persistent buffer of lines that have been "committed" by an
  // alt-screen toggle or a full-screen erase (`\x1B[2J`). The visible
  // screen below is what the current alt-screen / normal-mode pane is
  // drawing right now.
  const scrollback: string[] = [];
  const screen: string[] = [''];
  let row = 0;
  let col = 0;

  /** Move the current screen buffer onto scrollback, then start fresh. */
  function commitToScrollback(): void {
    // Trim trailing empty rows so we don't push a tail of blank
    // lines into scrollback every time a redraw happens (Codex
    // leaves many blank rows at the bottom of the alt-screen view).
    let end = screen.length;
    while (end > 0 && screen[end - 1].trim() === '') end--;
    for (let i = 0; i < end; i++) scrollback.push(screen[i]);
    screen.length = 1;
    screen[0] = '';
    row = 0;
    col = 0;
  }

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
            // Full-screen erase. Commit whatever was visible to
            // scrollback so multi-paragraph agent replies that scroll
            // through this clear path aren't lost from the feed.
            commitToScrollback();
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
          // Alt-screen ENTER: commit current content to scrollback
          // BEFORE clearing the screen for the alt buffer.
          commitToScrollback();
        } else if (cmd === 'l' && (param === '?1049' || param === '?47')) {
          // Alt-screen LEAVE: same — preserve what alt-screen drew
          // before restoring the normal screen.
          commitToScrollback();
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

  // Return scrollback + current visible screen as one continuous line
  // array. Consumers (filterChrome, selector detectors) operate on
  // this combined view and don't care about the boundary.
  return [...scrollback, ...screen];
}

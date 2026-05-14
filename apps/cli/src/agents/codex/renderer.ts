/**
 * Codex-specific virtual-terminal renderer.
 *
 * The shared `renderToLines` in @codeagent/shared is the byte-for-byte
 * implementation that Claude has shipped against for over a year — it
 * handles the cursor moves and erases that React Ink uses but does
 * NOT understand DECSTBM scroll regions (`\x1B[<top>;<bot>r`) or
 * Reverse Index (`\x1BM`). Codex uses both extensively to scroll its
 * chat-history zone (typically rows 1-31) while keeping the input box
 * fixed at the bottom (rows 30-36 or so). When a multi-paragraph reply
 * overflows the chat zone, Codex scrolls it — and content scrolling
 * out of the region is lost forever by the shared renderer.
 *
 * The forensic capture (real `script(1)` recording of a multi-line
 * reply, 185 KB) shows Codex's pattern:
 *
 *     ESC[?2026h         (begin synchronized update — no-op for us)
 *     ESC[1;31r          (set scroll region to rows 1-31)
 *     ESC[<row>;<col>H   (cursor positioning, many)
 *     ESC[K              (erase to end of line, many)
 *     ESC[r              (reset scroll region to full screen)
 *     ESC[30;36r         (set scroll region to rows 30-36, the input box)
 *     ESC[?2026l         (end synchronized update — no-op for us)
 *
 * Within the chat-zone region, Codex emits LF when the cursor is at
 * the bottom row of the region; the terminal must scroll the region
 * up (shift rows up by one, row at the top of the region scrolls OFF
 * into scrollback, row at the bottom becomes blank). It also emits
 * ESC M (Reverse Index) which scrolls DOWN — row at the bottom of
 * the region scrolls off, row at the top becomes blank. Both events
 * preserve the scrolled-off row in `scrollback` so the mobile feed
 * sees the full reply instead of just the most-recently-visible
 * portion of the chat zone.
 *
 * Claude is unaffected — this file is only used when the active
 * runtime strategy is CodexRuntimeStrategy.
 */
export function renderCodexBuffer(raw: string): string[] {
  // Persistent buffer of lines that scrolled off the visible region.
  // The mobile-feed filter consumes scrollback + visible screen as one
  // continuous array; the boundary is invisible to filterCodexChrome.
  const scrollback: string[] = [];

  // Visible-screen grid. Grows as `\n` and cursor moves write past the
  // end. Effectively unbounded — Codex's screen height is bounded by
  // the scroll region setting (see below).
  const screen: string[] = [''];
  let row = 0;
  let col = 0;

  // Active DECSTBM scroll region. `null` = no region set (full screen,
  // no scrolling). When set, `\n` at `bottom` triggers scroll-up and
  // `ESC M` at `top` triggers scroll-down. Both indices are 0-based.
  let scrollTop: number | null = null;
  let scrollBottom: number | null = null;

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

  /**
   * Scroll the current region up by one row. Top row of region goes
   * to scrollback (so we don't lose content), other rows shift up,
   * bottom row becomes blank. Cursor stays put.
   *
   * When no region is set (full screen), behaves like a normal
   * "advance into a new row" — append blank row at the end. No
   * content is lost; the writer just walked into new territory.
   */
  function scrollRegionUp(): void {
    if (scrollTop === null || scrollBottom === null) {
      // No region — just grow the screen (no scrolling needed).
      ensureRow();
      return;
    }
    // Make sure the region exists in the screen array.
    while (screen.length <= scrollBottom) screen.push('');
    // Preserve the top row before it disappears.
    if (screen[scrollTop].trim() !== '') {
      scrollback.push(screen[scrollTop]);
    }
    // Shift rows in the region up by one.
    for (let r = scrollTop; r < scrollBottom; r++) {
      screen[r] = screen[r + 1];
    }
    // Bottom row becomes blank.
    screen[scrollBottom] = '';
  }

  /**
   * Scroll the current region down by one row. Bottom row of region
   * goes to scrollback, other rows shift down, top row becomes blank.
   * Triggered by ESC M (Reverse Index) when the cursor is at the top
   * of the region.
   */
  function scrollRegionDown(): void {
    if (scrollTop === null || scrollBottom === null) {
      // No region — ESC M when not in a region just moves cursor up
      // without scrolling. Handled by the caller.
      return;
    }
    while (screen.length <= scrollBottom) screen.push('');
    if (screen[scrollBottom].trim() !== '') {
      scrollback.push(screen[scrollBottom]);
    }
    for (let r = scrollBottom; r > scrollTop; r--) {
      screen[r] = screen[r - 1];
    }
    screen[scrollTop] = '';
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
            // Full-screen erase — commit the visible region to
            // scrollback so chat history doesn't vanish through a
            // clear-screen redraw.
            for (let r = 0; r < screen.length; r++) {
              if (screen[r].trim() !== '') scrollback.push(screen[r]);
            }
            screen.length = 1;
            screen[0] = '';
            row = 0;
            col = 0;
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
        } else if (cmd === 'r') {
          // DECSTBM: Set Top and Bottom Margins. `\x1B[<top>;<bot>r`
          // arms a scroll region; `\x1B[r` (or `\x1B[;r`) resets to
          // full screen.
          if (param === '' || param === ';') {
            scrollTop = null;
            scrollBottom = null;
          } else {
            const p = param.split(';');
            const top = parseInt(p[0] ?? '1') || 1;
            const bot = parseInt(p[1] ?? '1') || 1;
            scrollTop = Math.max(0, top - 1);
            scrollBottom = Math.max(scrollTop, bot - 1);
          }
        }
        // Unhandled CSI commands (?2026h/l sync output, ?25h/l cursor
        // visibility, SGR colors, etc.) are silently skipped — they
        // don't affect captured text content.
      } else if (raw[i] === ']') {
        // OSC — swallow until BEL or ESC \
        i++;
        while (i < raw.length) {
          if (raw[i] === '\x07') break;
          if (raw[i] === '\x1B' && i + 1 < raw.length && raw[i + 1] === '\\') { i++; break; }
          i++;
        }
      } else if (raw[i] === 'M') {
        // ESC M — Reverse Index. If cursor is at top of scroll region,
        // scroll the region down. Otherwise just move cursor up.
        if (scrollTop !== null && row === scrollTop) {
          scrollRegionDown();
        } else {
          row = Math.max(0, row - 1);
        }
      } else if (raw[i] === 'D') {
        // ESC D — Index. If cursor is at bottom of scroll region,
        // scroll the region up. Otherwise just move cursor down.
        if (scrollBottom !== null && row === scrollBottom) {
          scrollRegionUp();
        } else {
          row++;
          ensureRow();
        }
      }
      // Other ESC- sequences (charset, save/restore cursor, etc.)
      // silently skipped — same as the shared renderer.
    } else if (ch === '\r') {
      if (i + 1 < raw.length && raw[i + 1] === '\n') {
        // CRLF
        if (scrollBottom !== null && row === scrollBottom) {
          scrollRegionUp();
        } else {
          row++;
          ensureRow();
        }
        col = 0;
        i++;
      } else {
        col = 0;
      }
    } else if (ch === '\n') {
      // LF in a scroll region at the bottom row scrolls the region
      // up; everywhere else it just advances the cursor and grows the
      // screen if needed.
      if (scrollBottom !== null && row === scrollBottom) {
        scrollRegionUp();
      } else {
        row++;
        ensureRow();
      }
      col = 0;
    } else if (ch >= ' ' || ch === '\t') {
      writeChar(ch);
    }

    i++;
  }

  return [...scrollback, ...screen];
}

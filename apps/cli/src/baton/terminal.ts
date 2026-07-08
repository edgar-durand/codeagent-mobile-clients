/**
 * Terminal-mode housekeeping for the baton hand-off (LOCAL_DRIVE → MOBILE_DRIVE).
 *
 * An interactive agent TUI (Claude Code's Ink renderer, Codex, …) turns several
 * terminal modes ON when it starts — focus reporting (`ESC[?1004h`), bracketed
 * paste (`ESC[?2004h`), mouse reporting — and turns them OFF again on a graceful
 * exit. When the baton hands control to mobile we hard-KILL the native TUI
 * (`AgentService.kill()` → SIGTERM), so that cleanup never runs and the modes
 * stay latched on.
 *
 * The visible symptom (Take Control on a local session): the terminal starts
 * spewing `^[[I^[[O` on its own. That's the terminal emitting focus-in/out
 * escapes (`ESC[I` / `ESC[O`) every time the window gains/loses focus while
 * focus reporting is still on — and, because the PTY teardown drops stdin back
 * to cooked mode, the tty ECHOES those bytes as literal caret notation onto the
 * now-frozen TUI frame.
 *
 * {@link parkTerminalForReadonly} resets exactly the modes the killed TUI left
 * on (so the terminal stops emitting focus/paste escapes at the source) and
 * parks stdin, since during MOBILE_DRIVE the terminal is a read-only view whose
 * keystrokes must neither echo onto the frozen frame nor be buffered for
 * injection when the native TUI respawns on hand-back.
 */

/** Reset sequence for the modes an interactive TUI leaves on after a hard kill.
 *  Kept deliberately narrow — only what a killed Ink/TUI renderer turns on and
 *  can't turn off — so we never clobber unrelated terminal state (no RIS/clear,
 *  no alt-screen toggle: Claude Code renders inline, never on the alt screen). */
export const TUI_MODE_RESET =
  '\x1b[?1004l' + // focus reporting off  → stops the ^[[I / ^[[O stream
  '\x1b[?2004l' + // bracketed paste off
  '\x1b[?1000l' + // mouse: normal tracking off
  '\x1b[?1002l' + // mouse: button-event tracking off
  '\x1b[?1003l' + // mouse: any-event tracking off
  '\x1b[?1006l' + // mouse: SGR extended mode off
  '\x1b[?25h'; // show cursor (a killed TUI may have hidden it)

export interface ParkableTerminal {
  out?: Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;
  inp?: Pick<NodeJS.ReadStream, 'isTTY' | 'setRawMode' | 'pause'>;
}

/**
 * Undo the terminal modes a hard-killed native TUI left on, and park stdin for
 * the read-only MOBILE_DRIVE phase. Idempotent and safe to call when stdout /
 * stdin aren't TTYs (no-op). Injectable streams for testing; defaults to the
 * real process streams.
 */
export function parkTerminalForReadonly(term: ParkableTerminal = {}): void {
  const out = term.out ?? process.stdout;
  const inp = term.inp ?? process.stdin;

  if (out.isTTY) {
    out.write(TUI_MODE_RESET);
  }
  // Read-only view: drop stdin so stray keystrokes don't get echoed onto the
  // frozen frame or buffered for the respawned TUI to swallow on hand-back.
  try {
    if (inp.isTTY && typeof inp.setRawMode === 'function') inp.setRawMode(false);
  } catch {
    /* setRawMode can throw on some non-TTY streams — best-effort */
  }
  inp.pause?.();
}

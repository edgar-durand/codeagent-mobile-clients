import { describe, it, expect, vi } from 'vitest';
import { parkTerminalForReadonly, TUI_MODE_RESET } from '../../src/baton/terminal';

function fakeTerm(opts: { outTTY: boolean; inTTY: boolean }) {
  const write = vi.fn();
  const setRawMode = vi.fn();
  const pause = vi.fn();
  return {
    term: {
      out: { isTTY: opts.outTTY, write } as never,
      inp: { isTTY: opts.inTTY, setRawMode, pause } as never,
    },
    write,
    setRawMode,
    pause,
  };
}

describe('parkTerminalForReadonly (baton hand-off)', () => {
  it('resets the TUI escape modes a hard-killed native TUI left on', () => {
    const { term, write } = fakeTerm({ outTTY: true, inTTY: true });
    parkTerminalForReadonly(term);
    expect(write).toHaveBeenCalledWith(TUI_MODE_RESET);
    // Focus reporting off is the load-bearing byte — it's what stops the
    // terminal spewing ^[[I / ^[[O once the tty drops back to cooked mode.
    expect(TUI_MODE_RESET).toContain('\x1b[?1004l');
    expect(TUI_MODE_RESET).toContain('\x1b[?2004l'); // bracketed paste off
  });

  it('parks stdin: leaves raw mode and pauses (read-only view)', () => {
    const { term, setRawMode, pause } = fakeTerm({ outTTY: true, inTTY: true });
    parkTerminalForReadonly(term);
    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on non-TTY stdout (never writes escapes)', () => {
    const { term, write, setRawMode, pause } = fakeTerm({ outTTY: false, inTTY: false });
    parkTerminalForReadonly(term);
    expect(write).not.toHaveBeenCalled();
    // setRawMode is TTY-gated; pause is always safe to call.
    expect(setRawMode).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(1);
  });
});

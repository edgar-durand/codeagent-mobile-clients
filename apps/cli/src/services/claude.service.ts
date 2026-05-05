import { IPtyStrategy, findInPath } from './pty/types';
import { UnixPtyStrategy } from './pty/unix.strategy';
import { WindowsPtyStrategy } from './pty/windows.strategy';
import { WindowsConPtyStrategy } from './pty/windows-conpty.strategy';

export interface ClaudeServiceOptions {
  cwd: string;
  onData?: (data: string) => void;
  onExit: (code: number) => void;
}

export class ClaudeService {
  private strategy: IPtyStrategy;

  constructor(private readonly opts: ClaudeServiceOptions) {
    const strategyOpts = {
      onData: opts.onData ?? (() => {}),
      onExit: opts.onExit,
    };
    if (process.platform === 'win32') {
      // Prefer ConPTY (real terminal) over the legacy pipe strategy:
      // without a TTY, Claude Code detects non-interactive mode, drops
      // into --print, waits 3s for stdin, and errors out. node-pty is
      // an optionalDependency with prebuilt binaries — if loading
      // fails (exotic arch, missing prebuild) we fall back to the old
      // pipe strategy so pairing still works at all.
      const conpty = WindowsConPtyStrategy.tryCreate(strategyOpts);
      if (conpty) {
        this.strategy = conpty;
      } else {
        console.error(
          '\n  ⚠ Windows: node-pty unavailable, falling back to pipe mode.\n' +
            '    Claude Code may exit immediately with "no stdin data" / "--print" errors.\n' +
            '    Install build tools or run codeam-cli inside WSL for the best experience.\n',
        );
        this.strategy = new WindowsPtyStrategy(strategyOpts);
      }
    } else {
      this.strategy = new UnixPtyStrategy(strategyOpts);
    }
  }

  spawn(): void {
    if (!findInPath('claude') && !findInPath('claude-code')) {
      console.error(
        '\n  ✗ claude not found in PATH.\n' +
          '    Install it with: npm install -g @anthropic-ai/claude-code\n',
      );
      process.exit(1);
    }

    const claudeCmd = findInPath('claude') ? 'claude' : 'claude-code';
    this.strategy.spawn(claudeCmd, this.opts.cwd);
  }

  /**
   * Send a command to Claude's stdin (remote control from mobile).
   *
   * Why two separate writes with a delay?
   * Same batching problem as selectOption: all bytes arriving in one write()
   * call are processed by readline in one synchronous run.  React Ink batches
   * the resulting state updates, so when '\r' fires the input's value is still
   * the pre-batch (empty/previous) state → Enter submits nothing and the text
   * stays visible-but-unsubmitted in the input field.
   *
   * Sending '\r' in a separate write() 50 ms later guarantees it arrives on
   * a fresh event-loop tick, after React has flushed the text into input state.
   */
  sendCommand(text: string): void {
    this.strategy.write(text);
    setTimeout(() => this.strategy.write('\r'), 50);
  }

  /**
   * Navigate a React Ink selector to the given 0-based target index and confirm.
   *
   * `fromIndex` is the current highlighted position (defaults to 0 for
   * numbered selectors which always start at the first option). For list-style
   * selectors (e.g. /mcp), the CLI sends `currentIndex` in the select_prompt
   * chunk so the client can pass it back here as `fromIndex`, enabling both
   * up-arrow and down-arrow navigation without always rewinding to position 0.
   *
   * Why not sendCommand(arrows + Enter) in one write()?
   * All bytes arrive as one chunk → readline fires all keypress events in the
   * same synchronous run → React Ink batches the state updates → each arrow
   * sees selectedIndex=0 → final state is still 0 or 1 → wrong option selected.
   *
   * Fix: send each arrow in a separate write(), ARROW_MS apart, so React has
   * time to process and re-render between each keystroke.  Enter is sent
   * ENTER_MS after the last arrow.
   */
  selectOption(targetIndex: number, fromIndex = 0): void {
    const delta = targetIndex - fromIndex;
    const steps = Math.abs(delta);
    const arrow  = delta >= 0 ? '\x1B[B' : '\x1B[A'; // ↓ or ↑

    const ARROW_MS = 80;
    const ENTER_MS = 200;

    if (steps === 0) {
      this.strategy.write('\r');
      return;
    }

    for (let i = 0; i < steps; i++) {
      setTimeout(() => { this.strategy.write(arrow); }, i * ARROW_MS);
    }
    setTimeout(() => {
      this.strategy.write('\r');
    }, steps * ARROW_MS + ENTER_MS);
  }

  /** Send Escape key to Claude (cancels interactive prompts). */
  sendEscape(): void {
    this.strategy.write('\x1b');
  }

  /** Send Ctrl+C to Claude. */
  interrupt(): void {
    this.strategy.write('\x03');
  }

  kill(): void {
    this.strategy.kill();
  }

  /**
   * Kill the current Claude process and relaunch it resuming the given session.
   * Pass auto=true to add --dangerously-skip-permissions (no confirmation prompts).
   */
  restart(sessionId: string, auto = false): void {
    const claudeCmd = findInPath('claude') ? 'claude' : 'claude-code';
    this.strategy.kill();
    const args = ['--resume', sessionId];
    if (auto) args.push('--dangerously-skip-permissions');
    this.strategy.spawn(claudeCmd, this.opts.cwd, args);
  }
}

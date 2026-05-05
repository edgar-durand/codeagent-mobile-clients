import { IPtyStrategy } from './pty/types';
import { UnixPtyStrategy } from './pty/unix.strategy';
import { WindowsPtyStrategy } from './pty/windows.strategy';
import { WindowsConPtyStrategy } from './pty/windows-conpty.strategy';
import { ensureClaudeInstalled } from './claude-installer';
import { buildClaudeLaunch, type ClaudeLaunch } from './claude-resolver';

export interface ClaudeServiceOptions {
  cwd: string;
  onData?: (data: string) => void;
  onExit: (code: number) => void;
}

export class ClaudeService {
  // Strategy is selected lazily inside spawn() so we can fall back from
  // ConPTY → legacy pipe at runtime if the native binding fails to load.
  // Methods called before spawn() (e.g. early kill/SIGINT) no-op safely.
  private strategy: IPtyStrategy | null = null;
  private readonly strategyOpts: { onData: (d: string) => void; onExit: (c: number) => void };

  constructor(private readonly opts: ClaudeServiceOptions) {
    this.strategyOpts = {
      onData: opts.onData ?? (() => {}),
      onExit: opts.onExit,
    };
  }

  async spawn(): Promise<void> {
    let launch = buildClaudeLaunch();
    if (!launch) {
      // Inline auto-install via Anthropic's official installer (curl|bash
      // on macOS/Linux, irm|iex on Windows). After the installer exits,
      // ensureClaudeInstalled() also prepends the known install dirs to
      // this process's PATH so the next buildClaudeLaunch() probe sees
      // the freshly-dropped binary without needing a shell restart.
      const installed = await ensureClaudeInstalled();
      if (installed) launch = buildClaudeLaunch();
      if (!launch) {
        const cmd =
          process.platform === 'win32'
            ? 'irm https://claude.ai/install.ps1 | iex'
            : 'curl -fsSL https://claude.ai/install.sh | bash';
        console.error(
          '\n  ✗ claude is required to continue. Install it manually with:\n' +
            `    ${cmd}\n` +
            '    Then restart your terminal and run `codeam pair` again.\n',
        );
        process.exit(1);
      }
    }

    if (process.platform === 'win32') {
      // Prefer ConPTY (real terminal) so Claude doesn't fall into its
      // "--print + 3s stdin wait" non-interactive path. The vendored
      // node-pty bundle (see scripts/vendor-node-pty.js) ships the
      // prebuilt conpty.node so this load is deterministic. Two
      // failure modes still possible:
      //
      //   1. require throws because the vendored bundle is corrupt or
      //      missing (e.g. AV quarantined the .node file). tryCreate
      //      returns null → pipe fallback.
      //   2. require succeeds but lib.spawn() throws — typically a
      //      mis-resolved cmd (e.g. a `.cmd` shim handed to ConPTY
      //      without a cmd.exe wrapper). Caught here → pipe fallback.
      const conpty = WindowsConPtyStrategy.tryCreate(this.strategyOpts);
      if (conpty) {
        try {
          conpty.spawn(launch.cmd, this.opts.cwd, launch.args);
          this.strategy = conpty;
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Best-effort cleanup of half-initialized state.
          try { conpty.dispose(); } catch { /* ignore */ }
          console.error(`\n  ⚠ ConPTY launch failed (${msg.split('\n')[0]})`);
          console.error('    Falling back to pipe mode (limited interactivity)…\n');
        }
      } else {
        console.error(
          '\n  ⚠ Windows: node-pty unavailable, falling back to pipe mode.\n' +
            '    Claude may exit with "no stdin data" / "--print" errors.\n' +
            '    Reinstall the CLI to fetch the prebuilt ConPTY binary, or run inside WSL.\n',
        );
      }
      const pipe = new WindowsPtyStrategy(this.strategyOpts);
      pipe.spawn(launch.cmd, this.opts.cwd, launch.args);
      this.strategy = pipe;
      return;
    }

    const unix = new UnixPtyStrategy(this.strategyOpts);
    unix.spawn(launch.cmd, this.opts.cwd, launch.args);
    this.strategy = unix;
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
    if (!this.strategy) return;
    const s = this.strategy;
    s.write(text);
    setTimeout(() => s.write('\r'), 50);
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
    if (!this.strategy) return;
    const s = this.strategy;
    const delta = targetIndex - fromIndex;
    const steps = Math.abs(delta);
    const arrow  = delta >= 0 ? '\x1B[B' : '\x1B[A'; // ↓ or ↑

    const ARROW_MS = 80;
    const ENTER_MS = 200;

    if (steps === 0) {
      s.write('\r');
      return;
    }

    for (let i = 0; i < steps; i++) {
      setTimeout(() => { s.write(arrow); }, i * ARROW_MS);
    }
    setTimeout(() => {
      s.write('\r');
    }, steps * ARROW_MS + ENTER_MS);
  }

  /** Send Escape key to Claude (cancels interactive prompts). */
  sendEscape(): void {
    this.strategy?.write('\x1b');
  }

  /** Send Ctrl+C to Claude. */
  interrupt(): void {
    this.strategy?.write('\x03');
  }

  kill(): void {
    this.strategy?.kill();
  }

  /**
   * Kill the current Claude process and relaunch it resuming the given session.
   * Pass auto=true to add --dangerously-skip-permissions (no confirmation prompts).
   */
  restart(sessionId: string, auto = false): void {
    if (!this.strategy) return;
    const extraArgs = ['--resume', sessionId];
    if (auto) extraArgs.push('--dangerously-skip-permissions');
    const launch: ClaudeLaunch | null = buildClaudeLaunch(extraArgs);
    if (!launch) return;
    this.strategy.kill();
    this.strategy.spawn(launch.cmd, this.opts.cwd, launch.args);
  }
}

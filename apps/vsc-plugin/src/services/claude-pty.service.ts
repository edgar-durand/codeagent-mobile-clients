import * as fs from 'fs';
import * as path from 'path';
import * as pty from 'node-pty';

/**
 * PTY-based Claude Code driver — same technique codeam-cli + the
 * VSC TerminalOpsService use, so Claude sees `stdin.isTTY === true`
 * and its React Ink selectors work.
 *
 * Previously this drove `claude` via a Python helper script written
 * to `os.tmpdir()` and execvp'd. That had three real problems
 * (#88): TOCTOU on the helper file, a leak when the extension host
 * crashed (the .py file stayed at mode 0o644 in tmp), and
 * `process.env.COLUMNS` mutation on every resize that affected
 * every other extension in the host. Replaced with a direct
 * `pty.spawn(claude, [], …)` — node-pty allocates the PTY pair
 * inside the native binding so we don't write anything to disk and
 * `pty.resize()` updates the master without touching the host env.
 *
 * Why a new PTY instead of piping into VS Code's existing Claude
 * Code terminal: the Claude Code extension creates its own
 * Pseudoterminal, which is opaque to VS Code's shell-integration
 * API. We cannot read its raw bytes. Spawning our own process gives
 * us full control and lets us emit the codeam-cli-compatible SSE
 * chunk stream the mobile client already knows how to render.
 */

function findInPath(binary: string): string | null {
  const parts = (process.env.PATH ?? '').split(path.delimiter);
  const names = process.platform === 'win32' ? [`${binary}.exe`, `${binary}.cmd`, binary] : [binary];
  for (const dir of parts) {
    for (const name of names) {
      try {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isFile()) return full;
      } catch { /* ignore */ }
    }
  }
  return null;
}

export interface ClaudePtyOptions {
  cwd: string;
  cols?: number;
  rows?: number;
  onData: (data: string) => void;
  onExit: (code: number) => void;
}

/**
 * Drives a PTY-wrapped `claude` process. Mirrors the shape of
 * apps/cli/src/services/claude.service.ts so the plugin produces
 * the exact same keystroke timing (React Ink batching is a real
 * footgun).
 */
export class ClaudePtyService {
  private proc: pty.IPty | null = null;
  private dataListener: pty.IDisposable | null = null;
  private exitListener: pty.IDisposable | null = null;
  private cols: number;
  private rows: number;

  constructor(private readonly opts: ClaudePtyOptions) {
    this.cols = opts.cols ?? 220;
    this.rows = opts.rows ?? 50;
  }

  /** Launch `claude` under a node-pty PTY. Returns false if claude is missing or pty.spawn throws. */
  spawn(): boolean {
    const claudeCmd = findInPath('claude') ?? findInPath('claude-code');
    if (!claudeCmd) return false;

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
    };

    try {
      const term = pty.spawn(claudeCmd, [], {
        name: 'xterm-256color',
        cols: Math.max(1, Math.min(this.cols, 500)),
        rows: Math.max(1, Math.min(this.rows, 200)),
        cwd: this.opts.cwd,
        env,
        useConpty: process.platform === 'win32' ? true : undefined,
      } as pty.IPtyForkOptions & pty.IWindowsPtyForkOptions);
      this.proc = term;
      this.dataListener = term.onData((data) => this.opts.onData(data));
      this.exitListener = term.onExit(({ exitCode }) => {
        this.cleanup();
        this.opts.onExit(exitCode);
      });
      return true;
    } catch {
      // node-pty native binding missing for this platform OR exec
      // failed before the child reported back. We don't fall back
      // to a non-PTY shell — Claude's React Ink TUI is unusable
      // without a real TTY (selectors don't render, prompts hang).
      // Caller surfaces the failure to the user.
      return false;
    }
  }

  /** Raw write to the PTY — used by Pseudoterminal.handleInput. */
  write(data: string | Buffer): void {
    if (!this.proc) return;
    this.proc.write(typeof data === 'string' ? data : data.toString('utf8'));
  }

  /**
   * Send a command from a remote source (mobile). Splits the submit
   * Enter into a separate write 50 ms later so React Ink has time
   * to flush the text into input state — otherwise the Enter lands
   * in the same synchronous run and submits an empty input.
   */
  sendCommand(text: string): void {
    this.write(text);
    setTimeout(() => this.write('\r'), 50);
  }

  /** Navigate a selector with per-arrow delay so React Ink doesn't batch. */
  selectOption(targetIndex: number, fromIndex = 0): void {
    const delta = targetIndex - fromIndex;
    const steps = Math.abs(delta);
    const arrow = delta >= 0 ? '\x1B[B' : '\x1B[A';
    const ARROW_MS = 80;
    const ENTER_MS = 200;

    if (steps === 0) {
      this.write('\r');
      return;
    }
    for (let i = 0; i < steps; i++) {
      setTimeout(() => this.write(arrow), i * ARROW_MS);
    }
    setTimeout(() => this.write('\r'), steps * ARROW_MS + ENTER_MS);
  }

  sendEscape(): void { this.write('\x1b'); }
  interrupt(): void { this.write('\x03'); }

  /**
   * Update terminal size. node-pty forwards the new dimensions via
   * TIOCSWINSZ on the master so the child sees a clean SIGWINCH —
   * no extension-host env mutation required.
   */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (!this.proc) return;
    try {
      this.proc.resize(
        Math.max(1, Math.min(cols, 500)),
        Math.max(1, Math.min(rows, 200)),
      );
    } catch { /* ignore — PTY may have just exited */ }
  }

  kill(): void {
    const proc = this.proc;
    this.proc = null;
    if (this.exitListener) {
      try { this.exitListener.dispose(); } catch { /* ignore */ }
      this.exitListener = null;
    }
    if (this.dataListener) {
      try { this.dataListener.dispose(); } catch { /* ignore */ }
      this.dataListener = null;
    }
    if (proc) {
      try { proc.kill(); } catch { /* ignore */ }
    }
  }

  isAlive(): boolean {
    return this.proc !== null;
  }

  private cleanup(): void {
    if (this.dataListener) {
      try { this.dataListener.dispose(); } catch { /* ignore */ }
      this.dataListener = null;
    }
    if (this.exitListener) {
      try { this.exitListener.dispose(); } catch { /* ignore */ }
      this.exitListener = null;
    }
    this.proc = null;
  }
}

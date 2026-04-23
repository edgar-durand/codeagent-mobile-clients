import { spawn, ChildProcess } from 'child_process';
import { IPtyStrategy, PtyStrategyOptions } from './types';

/**
 * Windows PTY strategy.
 *
 * Windows has no Unix PTY subsystem, so we can't use Python's pty.openpty().
 * Instead we spawn Claude with piped stdout so the output service can capture
 * it, while still writing commands to stdin.
 *
 * Key difference from the old spawnDirect fallback:
 *   Old:  stdio ['pipe', 'inherit', 'inherit'] → stdout goes directly to the
 *         terminal, onData never fires, nothing streams to mobile.
 *   New:  stdio ['pipe', 'pipe', 'inherit'] → stdout is a readable pipe,
 *         proc.stdout.on('data') feeds the OutputService as on Mac/Linux.
 *
 * Limitation: without a real PTY, Claude Code does not see stdin.isTTY === true.
 * Interactive selectors still work because we inject the same arrow/Enter
 * sequences via stdin — Claude just won't show the full TUI chrome.
 *
 * TODO (Windows PTY): If users report missing output or broken selectors on
 * Windows, the fix is to replace this strategy with node-pty, which uses the
 * native ConPTY API (Windows 10+) and gives Claude a real TTY.
 * node-pty is a native addon (requires build toolchain on install), so it was
 * intentionally left out for now to keep the package dependency-free.
 * See: https://github.com/microsoft/node-pty
 */
export class WindowsPtyStrategy implements IPtyStrategy {
  private proc: ChildProcess | null = null;

  constructor(private readonly opts: PtyStrategyOptions) {}

  spawn(cmd: string, cwd: string, args: string[] = []): void {
    this.proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLUMNS: '220',
        LINES: '50',
      },
      shell: true,
    });

    this.proc.on('error', (err) => {
      console.error(
        `\n  ✗ Failed to launch Claude Code: ${err.message}\n` +
          '    Make sure claude is correctly installed: npm install -g @anthropic-ai/claude-code\n',
      );
      process.exit(1);
    });

    // Capture Claude's stdout for the output service (streams to mobile)
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      this.opts.onData(chunk.toString('utf8'));
    });

    // Poke stdin so Claude doesn't immediately drop into no-stdin mode
    this.proc.stdin?.write('');

    // Forward user keystrokes from the local terminal → Claude's stdin
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this.stdinHandler);

    this.proc.on('exit', (code) => {
      this.dispose();
      this.opts.onExit(code ?? 0);
    });
  }

  write(data: string | Buffer): void {
    this.proc?.stdin?.write(data);
  }

  kill(): void {
    this.proc?.kill();
    this.dispose();
  }

  dispose(): void {
    process.stdin.removeListener('data', this.stdinHandler);
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
  }

  private stdinHandler = (chunk: Buffer): void => {
    this.proc?.stdin?.write(chunk);
  };
}

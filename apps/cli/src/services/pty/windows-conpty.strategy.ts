import { IPtyStrategy, PtyStrategyOptions } from './types';

/**
 * Preferred Windows strategy — uses ConPTY (Windows 10+) via the
 * optional `node-pty` dependency to give Claude Code a real
 * terminal.
 *
 * Why this exists
 * ───────────────
 * The legacy `windows.strategy.ts` spawns Claude with
 * `stdio: ['pipe', 'pipe', 'inherit']` so the parent can capture
 * stdout and forward mobile commands to stdin. The side effect:
 * Claude's stdin is a pipe (not a TTY), so when it boots it detects
 * non-interactive mode, falls into its `--print` path, waits 3 s for
 * piped input, then errors out with:
 *
 *   Warning: no stdin data received in 3s, proceeding without it.
 *   Error: Input must be provided either through stdin or as a
 *          prompt argument when using --print
 *
 * Solution: spawn Claude through ConPTY so it sees a real terminal,
 * exactly like the macOS / Linux path uses Python's pty.openpty().
 * `node-pty` bundles prebuilt binaries for Windows x64 / arm64 since
 * 1.0.0, so no MSVC toolchain is needed at install time on common
 * machines.
 *
 * Lifecycle
 * ─────────
 * The macOS path is intentionally left untouched. Loading is dynamic
 * via `tryCreate()` so a missing or unloadable `node-pty` (e.g.
 * exotic CPU arch with no prebuild) gracefully falls back to
 * WindowsPtyStrategy at the call site.
 */

interface PtyDataDisposable {
  dispose: () => void;
}

interface IPty {
  pid: number;
  onData(cb: (data: string) => void): PtyDataDisposable;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): PtyDataDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      useConpty?: boolean;
      conptyInheritCursor?: boolean;
    },
  ): IPty;
}

/**
 * Lazy-load `node-pty`. Returns `null` if the optional dependency
 * isn't installed, the prebuild doesn't match the host arch, or the
 * binary fails to load (corrupt install, AV blocking, etc.).
 */
function loadNodePty(): NodePtyModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node-pty') as NodePtyModule;
  } catch {
    return null;
  }
}

export class WindowsConPtyStrategy implements IPtyStrategy {
  private pty: IPty | null = null;
  private dataSub: PtyDataDisposable | null = null;
  private exitSub: PtyDataDisposable | null = null;
  private rawModeSet = false;

  /**
   * Factory that returns a working ConPTY strategy or `null` if
   * node-pty can't load. The caller (claude.service.ts) decides
   * whether to fall back to the legacy pipe strategy.
   */
  static tryCreate(opts: PtyStrategyOptions): WindowsConPtyStrategy | null {
    const lib = loadNodePty();
    if (!lib) return null;
    return new WindowsConPtyStrategy(opts, lib);
  }

  private constructor(
    private readonly opts: PtyStrategyOptions,
    private readonly lib: NodePtyModule,
  ) {}

  spawn(cmd: string, cwd: string, args: string[] = []): void {
    // Forwarding `cmd` directly works for `claude.cmd` / `claude.exe`
    // on PATH because ConPTY launches via cmd.exe under the hood;
    // no `shell: true` workaround needed.
    try {
      this.pty = this.lib.spawn(cmd, args, {
        name: 'xterm-256color',
        cols: 220,
        rows: 50,
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          FORCE_COLOR: '1',
        },
        useConpty: true,
        conptyInheritCursor: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `\n  ✗ Failed to launch Claude Code via ConPTY: ${msg}\n` +
          '    Make sure claude is installed: npm install -g @anthropic-ai/claude-code\n',
      );
      this.opts.onExit(1);
      return;
    }

    this.dataSub = this.pty.onData((data) => {
      // Mirror to the local terminal so the user sees Claude's UI on
      // Windows the same way they do on macOS, AND feed the chunk
      // parser that streams to mobile.
      process.stdout.write(data);
      this.opts.onData(data);
    });

    this.exitSub = this.pty.onExit(({ exitCode }) => {
      this.dispose();
      this.opts.onExit(exitCode ?? 0);
    });

    // Forward local terminal keystrokes → Claude's stdin (via PTY).
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
        this.rawModeSet = true;
      } catch {
        /* not a TTY in this terminal — fine, mobile commands still work */
      }
    }
    process.stdin.resume();
    process.stdin.on('data', this.stdinHandler);
  }

  write(data: string | Buffer): void {
    if (!this.pty) return;
    this.pty.write(typeof data === 'string' ? data : data.toString('utf8'));
  }

  kill(): void {
    try {
      this.pty?.kill();
    } catch {
      /* already dead */
    }
    this.dispose();
  }

  dispose(): void {
    this.dataSub?.dispose();
    this.exitSub?.dispose();
    this.dataSub = null;
    this.exitSub = null;
    process.stdin.removeListener('data', this.stdinHandler);
    if (this.rawModeSet && process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      this.rawModeSet = false;
    }
    this.pty = null;
  }

  private stdinHandler = (chunk: Buffer): void => {
    this.pty?.write(chunk.toString('utf8'));
  };
}

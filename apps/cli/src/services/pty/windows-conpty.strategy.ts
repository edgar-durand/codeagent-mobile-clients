import * as path from 'path';
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
 * Load `node-pty` from the slim copy we vendor into our own dist
 * folder at build time (see scripts/vendor-node-pty.js). Falls back
 * to a normal `require('node-pty')` for the dev-mode path where the
 * bundle isn't built yet.
 *
 * Returns `null` if:
 *   - the vendored bundle doesn't exist (e.g. local-build dist not
 *     produced yet, or somebody trimmed `dist/` in CI), AND
 *   - no `node-pty` is installed alongside as a regular dep.
 *
 * At runtime in a published install, the vendored path is what hits
 * — so the prebuilt `conpty.node` is guaranteed to be on disk and
 * the load is deterministic regardless of the user's npm config.
 */
function loadNodePty(): NodePtyModule | null {
  // Prefer the vendored copy. `__dirname` after tsup bundles into
  // dist/ resolves to the dist directory at runtime, so the vendored
  // path lives at `<install>/dist/vendor/node-pty/`.
  const vendoredPath = path.join(__dirname, 'vendor', 'node-pty');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(vendoredPath) as NodePtyModule;
  } catch (vendorErr) {
    // Dev-mode fallback (running from src/ with tsx, no built dist yet).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('node-pty') as NodePtyModule;
    } catch {
      // Re-throw the vendor error since that's the path used in prod.
      void vendorErr;
      return null;
    }
  }
}

export class WindowsConPtyStrategy implements IPtyStrategy {
  private pty: IPty | null = null;
  private dataSub: PtyDataDisposable | null = null;
  private exitSub: PtyDataDisposable | null = null;
  private rawModeSet = false;
  private resizeHandler: (() => void) | null = null;

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
    //
    // Errors here (most commonly: native `conpty.node` failed to load
    // because the prebuild for the host arch wasn't bundled or got
    // removed by AV) are RE-THROWN, not handled. ClaudeService catches
    // and falls back to the legacy WindowsPtyStrategy so a missing
    // ConPTY binary doesn't kill the whole pairing flow.
    // Match the local terminal's actual size so Claude's React Ink UI
    // doesn't render at a phantom width and look mangled on the user's
    // screen. Conservative fallbacks if columns/rows aren't available
    // (e.g. running under a non-TTY parent).
    const cols = process.stdout.columns && process.stdout.columns > 0
      ? process.stdout.columns
      : 120;
    const rows = process.stdout.rows && process.stdout.rows > 0
      ? process.stdout.rows
      : 30;

    this.pty = this.lib.spawn(cmd, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
      },
      useConpty: true,
      conptyInheritCursor: false,
    });

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

    // Forward terminal resizes so Claude's UI re-flows when the user
    // resizes the window. Without this, the PTY stays at the launch
    // size and any reflowed content drifts off-screen.
    this.resizeHandler = () => {
      const c = process.stdout.columns && process.stdout.columns > 0
        ? process.stdout.columns
        : cols;
      const r = process.stdout.rows && process.stdout.rows > 0
        ? process.stdout.rows
        : rows;
      try {
        this.pty?.resize(c, r);
      } catch {
        /* pty already gone */
      }
    };
    process.stdout.on('resize', this.resizeHandler);
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
    if (this.resizeHandler) {
      process.stdout.removeListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
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

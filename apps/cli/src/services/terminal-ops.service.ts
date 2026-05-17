/**
 * PTY-backed terminal session manager for the codeam-cli. Bridges
 * the IDE's TerminalProvider commands (open / write / resize /
 * close) to a child shell spawned under node-pty. Data flows in
 * both directions via the existing relay's chunk channel — the
 * IDE host subscribes through `provider.subscribe()` and receives
 * `terminal_data` chunks.
 *
 * Sessions are keyed by an opaque id (uuid) the client receives
 * from `terminal_open` and includes in every subsequent
 * write/resize/close. We cap concurrent sessions per cli instance
 * so a runaway client can't fork the user out of memory.
 */
import { randomUUID } from 'crypto';
import path from 'path';
// Types only — the actual module is required lazily inside
// `loadNodePty()` so the CLI doesn't blow up at startup when
// `pty.node` is missing for the running platform (the bug
// reported on darwin-arm64 in 2.10.x: tsup statically bundled
// `unixTerminal.js`, which calls `loadNativeModule('pty.node')`
// at module-eval time and crashes the whole CLI).
import type * as pty from 'node-pty';

const MAX_CONCURRENT_SESSIONS = 4;

interface Session {
  id: string;
  pty: pty.IPty;
  /** Listeners registered for data + exit events. The relay
   * pushes each chunk through these; we keep references so we
   * can shut down cleanly on close. */
  dataListener: pty.IDisposable;
  exitListener: pty.IDisposable;
}

/**
 * Mirror of the loader pattern in `windows-conpty.strategy.ts`:
 * resolve the vendored slim copy first (the path tsup-built dist
 * runs from), then fall back to a regular `require('node-pty')`
 * for the dev path. Returns null on full failure so the caller
 * can surface a clean error instead of a hard crash — keeping
 * the CLI alive for users on platforms whose `pty.node` we don't
 * ship (currently Linux: node-pty 1.1.x has no Linux prebuild).
 *
 * `nodePtyModule` is memoized so the lookup + native dlopen runs
 * at most once per process even when several terminals are
 * opened back-to-back.
 */
type NodePtyModule = typeof import('node-pty');
let nodePtyModule: NodePtyModule | null | undefined;

function loadNodePty(): NodePtyModule | null {
  if (nodePtyModule !== undefined) return nodePtyModule;
  const vendoredPath = path.join(__dirname, 'vendor', 'node-pty');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nodePtyModule = require(vendoredPath) as NodePtyModule;
    return nodePtyModule;
  } catch {
    // Dev-mode fallback (tsx running from src/ without a built dist).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      nodePtyModule = require('node-pty') as NodePtyModule;
      return nodePtyModule;
    } catch {
      nodePtyModule = null;
      return nodePtyModule;
    }
  }
}

const sessions = new Map<string, Session>();

export interface TerminalDataPush {
  /** Stable session id from `openTerminal`. */
  sessionId: string;
  /** UTF-8 chunk. */
  data: string;
}

export interface TerminalExitPush {
  sessionId: string;
  exitCode: number;
}

type DataHandler = (push: TerminalDataPush) => void;
type ExitHandler = (push: TerminalExitPush) => void;

let onDataHandler: DataHandler | null = null;
let onExitHandler: ExitHandler | null = null;

/** Wire global push handlers — typically called once during cli
 * bootstrap. The relay forwards every push as an `event` chunk
 * via the existing output stream. */
export function registerTerminalHandlers(opts: {
  onData: DataHandler;
  onExit: ExitHandler;
}): void {
  onDataHandler = opts.onData;
  onExitHandler = opts.onExit;
}

/** Pick a sensible default shell per platform. Mirrors the
 * heuristics VS Code's integrated terminal uses:
 *   - macOS / Linux: $SHELL → /bin/zsh → /bin/bash → /bin/sh
 *   - Windows: $COMSPEC → pwsh.exe → powershell.exe → cmd.exe
 * node-pty handles ConPTY on Windows transparently as long as the
 * prebuilt binary is installed (vendor-node-pty.js does this at
 * cli build time). */
function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC ?? 'powershell.exe';
  }
  return process.env.SHELL ?? '/bin/bash';
}

export function openTerminal(opts: {
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
}): { sessionId: string } | { error: string } {
  if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
    return { error: `Too many open terminals (max ${MAX_CONCURRENT_SESSIONS})` };
  }
  const shell = opts.shell ?? defaultShell();
  const cwd = opts.cwd ?? process.cwd();
  // On Windows we ask ConPTY to emit pure VT100 sequences (the
  // default) — xterm.js renders these directly. On posix `bash -l`
  // would also work, but a plain spawn keeps existing shell
  // configs (rc files, prompts) intact.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  // node-pty on Windows respects FORCE_COLOR for ANSI passthrough;
  // posix shells need it set explicitly when stdin isn't a real TTY.
  env.FORCE_COLOR = '1';
  const ptyMod = loadNodePty();
  if (!ptyMod) {
    return {
      error:
        `node-pty native module unavailable on ${process.platform}-${process.arch}; ` +
        `terminal feature disabled for this platform`,
    };
  }
  try {
    const term = ptyMod.spawn(shell, [], {
      name: 'xterm-256color',
      cols: Math.max(1, Math.min(opts.cols ?? 80, 500)),
      rows: Math.max(1, Math.min(opts.rows ?? 24, 200)),
      cwd,
      env,
      // Windows-specific: ConPTY is the default on Win 10 1809+
      // and is what we want. node-pty falls back to winpty
      // automatically on older builds.
      useConpty: process.platform === 'win32' ? true : undefined,
    } as pty.IPtyForkOptions & pty.IWindowsPtyForkOptions);
    const id = randomUUID();
    const dataListener = term.onData((data) => {
      onDataHandler?.({ sessionId: id, data });
    });
    const exitListener = term.onExit(({ exitCode }) => {
      onExitHandler?.({ sessionId: id, exitCode });
      sessions.delete(id);
    });
    sessions.set(id, { id, pty: term, dataListener, exitListener });
    return { sessionId: id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'spawn failed' };
  }
}

export function writeTerminal(sessionId: string, data: string): { ok: boolean; error?: string } {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false, error: 'No such session' };
  try {
    s.pty.write(data);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'write failed' };
  }
}

export function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number,
): { ok: boolean; error?: string } {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false, error: 'No such session' };
  try {
    s.pty.resize(Math.max(1, Math.min(cols, 500)), Math.max(1, Math.min(rows, 200)));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'resize failed' };
  }
}

export function closeTerminal(sessionId: string): { ok: boolean } {
  const s = sessions.get(sessionId);
  if (!s) return { ok: true };
  try {
    s.dataListener.dispose();
    s.exitListener.dispose();
    s.pty.kill();
  } catch {
    /* already dead */
  }
  sessions.delete(sessionId);
  return { ok: true };
}

/** Close all sessions — call on cli shutdown. */
export function closeAllTerminals(): void {
  for (const id of Array.from(sessions.keys())) closeTerminal(id);
}

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
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
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

/**
 * Unified session shape so the IDE terminal works on every
 * platform regardless of whether node-pty has a prebuilt binary
 * for the host. Two implementations live below: `NodePtySession`
 * (Windows + Mac, when node-pty's prebuild is available) and
 * `PythonPtySession` (Linux fallback — node-pty 1.1.x ships no
 * Linux prebuild). Both expose the same `write` / `kill` shape
 * the open/write/close/closeAll handlers consume.
 */
interface Session {
  id: string;
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  kill(): void;
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

/**
 * Inline Python 3 helper that opens a real PTY pair via `pty.openpty`,
 * forks, execs the requested shell with the PTY slave wired to
 * stdin/stdout/stderr, and proxies stdin / stdout between the
 * parent Node process and the shell. Used as the Linux fallback —
 * node-pty 1.1.x ships zero Linux prebuilds, so without this every
 * Linux user (cloud codespaces, in particular) would see
 * "Terminal error: Could not open terminal." Mac users could go
 * either way; we prefer node-pty when its darwin prebuild is
 * available, but the Python helper is a complete fallback if not.
 *
 * Resize is exposed via a magic byte sequence on stdin:
 *   `\x00CW <rows> <cols>\n`
 * The helper intercepts the prefix and calls `TIOCSWINSZ` instead
 * of forwarding the bytes to the shell. Anything else on stdin is
 * forwarded verbatim. The marker prefix uses NULs which are
 * invalid in human-typed terminal input, so collision with real
 * user keystrokes is impossible.
 */
const PYTHON_TERMINAL_HELPER = `import os,pty,sys,select,signal,struct,fcntl,termios,errno,re
m,s=pty.openpty()
try:
    cols=int(os.environ.get('COLUMNS','80'))
    rows=int(os.environ.get('LINES','24'))
    fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
except Exception:pass
pid=os.fork()
if pid==0:
    os.close(m)
    os.setsid()
    try:fcntl.ioctl(s,termios.TIOCSCTTY,0)
    except Exception:pass
    for fd in[0,1,2]:os.dup2(s,fd)
    if s>2:os.close(s)
    os.execvp(sys.argv[1],sys.argv[1:])
    sys.exit(127)
os.close(s)
done=[False]
def onchld(n,f):
    try:os.waitpid(pid,os.WNOHANG)
    except Exception:pass
    done[0]=True
signal.signal(signal.SIGCHLD,onchld)
signal.signal(signal.SIGHUP,signal.SIG_IGN)
i=sys.stdin.fileno()
o=sys.stdout.fileno()
in_buf=b''
resize_re=re.compile(rb'\\x00CW (\\d+) (\\d+)\\n')
while not done[0]:
    try:r,_,_=select.select([i,m],[],[],0.1)
    except OSError as e:
        if e.errno==errno.EINTR:continue
        break
    if i in r:
        try:
            d=os.read(i,4096)
            if not d:break
            in_buf+=d
            while True:
                mo=resize_re.search(in_buf)
                if not mo:break
                try:
                    rows=int(mo.group(1));cols=int(mo.group(2))
                    fcntl.ioctl(m,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
                except Exception:pass
                in_buf=in_buf[:mo.start()]+in_buf[mo.end():]
            if in_buf:
                # Don't forward a dangling NUL that might be the
                # start of an incomplete resize marker — hold it
                # until the next read so the regex matches.
                nul=in_buf.rfind(b'\\x00')
                if nul>=0 and len(in_buf)-nul<32:
                    tail=in_buf[nul:];body=in_buf[:nul]
                    if body:os.write(m,body)
                    in_buf=tail
                else:
                    os.write(m,in_buf);in_buf=b''
        except OSError:break
    if m in r:
        try:
            d=os.read(m,4096)
            if d:os.write(o,d)
        except OSError:done[0]=True
try:os.kill(pid,signal.SIGTERM)
except Exception:pass
try:
    _,st=os.waitpid(pid,0)
    sys.exit((st>>8)&0xFF)
except Exception:sys.exit(0)
`;

function findPython3(): string | null {
  // PATH lookup — we don't ship Python ourselves. Falls back to
  // `python` only if `python3` isn't on PATH (some minimal Linux
  // images use the bare name).
  for (const name of ['python3', 'python']) {
    try {
      const out = require('child_process').spawnSync('which', [name], { encoding: 'utf8' });
      if (out.status === 0 && out.stdout?.trim()) return out.stdout.trim();
    } catch {
      /* keep searching */
    }
  }
  return null;
}

/**
 * Python-helper backed terminal session. Used on Linux always and
 * on Mac when node-pty's darwin prebuild isn't available.
 */
function createPythonSession(
  id: string,
  shell: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  cols: number,
  rows: number,
): Session | { error: string } {
  const python = findPython3();
  if (!python) {
    return { error: 'python3 not found on PATH — required for terminal sessions on Linux/macOS without node-pty.' };
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(python, ['-c', PYTHON_TERMINAL_HELPER, shell], {
      cwd,
      env: { ...env, COLUMNS: String(cols), LINES: String(rows) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'python spawn failed' };
  }
  child.stdout.on('data', (buf: Buffer) => {
    onDataHandler?.({ sessionId: id, data: buf.toString('utf8') });
  });
  child.stderr.on('data', (buf: Buffer) => {
    // PTY shells write *everything* to stdout; stderr from the
    // helper script itself usually means the python child died
    // mid-fork. Surface it through the same chunk channel so the
    // user sees it instead of a silent hang.
    onDataHandler?.({ sessionId: id, data: buf.toString('utf8') });
  });
  child.on('exit', (code) => {
    onExitHandler?.({ sessionId: id, exitCode: code ?? 0 });
    sessions.delete(id);
  });
  return {
    id,
    write(data: string) {
      try {
        child.stdin.write(data);
      } catch {
        /* stdin already closed */
      }
    },
    resize(cs: number, rs: number) {
      // The helper intercepts this marker — see PYTHON_TERMINAL_HELPER.
      try {
        child.stdin.write(`\x00CW ${rs} ${cs}\n`);
      } catch {
        /* ignore */
      }
    },
    kill() {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    },
  };
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
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
  };
  const cols = Math.max(1, Math.min(opts.cols ?? 80, 500));
  const rows = Math.max(1, Math.min(opts.rows ?? 24, 200));
  const id = randomUUID();

  // Prefer node-pty when its prebuilt binary loads cleanly — best
  // fidelity (ConPTY on Windows, native pty syscalls on Mac).
  // Fall back to the Python helper when node-pty isn't available
  // (Linux always, dev-environment Mac with a broken install).
  const ptyMod = loadNodePty();
  if (ptyMod) {
    try {
      const term = ptyMod.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
        useConpty: process.platform === 'win32' ? true : undefined,
      } as pty.IPtyForkOptions & pty.IWindowsPtyForkOptions);
      const dataListener = term.onData((data) => {
        onDataHandler?.({ sessionId: id, data });
      });
      const exitListener = term.onExit(({ exitCode }) => {
        onExitHandler?.({ sessionId: id, exitCode });
        sessions.delete(id);
      });
      sessions.set(id, {
        id,
        write: (d) => term.write(d),
        resize: (cs, rs) => term.resize(cs, rs),
        kill: () => {
          dataListener.dispose();
          exitListener.dispose();
          term.kill();
        },
      });
      return { sessionId: id };
    } catch (e) {
      // node-pty failed mid-spawn (often a dlopen mismatch). Don't
      // give up — fall through to the Python helper if available.
      if (process.platform === 'win32') {
        return { error: e instanceof Error ? e.message : 'spawn failed' };
      }
    }
  } else if (process.platform === 'win32') {
    // Windows REQUIRES node-pty (no Python fallback for ConPTY).
    return {
      error:
        `node-pty native module unavailable on ${process.platform}-${process.arch}; ` +
        `terminal feature disabled for this platform`,
    };
  }

  const sess = createPythonSession(id, shell, cwd, env, cols, rows);
  if ('error' in sess) return { error: sess.error };
  sessions.set(id, sess);
  return { sessionId: id };
}

export function writeTerminal(sessionId: string, data: string): { ok: boolean; error?: string } {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false, error: 'No such session' };
  try {
    s.write(data);
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
    s.resize?.(Math.max(1, Math.min(cols, 500)), Math.max(1, Math.min(rows, 200)));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'resize failed' };
  }
}

export function closeTerminal(sessionId: string): { ok: boolean } {
  const s = sessions.get(sessionId);
  if (!s) return { ok: true };
  try {
    s.kill();
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

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * PTY-based Claude Code driver — same technique codeam-cli uses so
 * Claude sees `stdin.isTTY === true` and its React Ink selectors work.
 *
 * Why Python instead of `script`:
 *   `script` calls tcgetattr(STDIN_FILENO) which fails when stdin is a
 *   pipe/socket (which it always is when spawned from an extension
 *   host). Python's pty.openpty() creates the PTY pair at OS level
 *   without requiring the parent's stdin to be a terminal.
 *
 * Why a new PTY instead of piping into VS Code's existing Claude Code
 * terminal: the Claude Code extension creates its own Pseudoterminal,
 * which is opaque to VS Code's shell-integration API. We cannot read
 * its raw bytes. Spawning our own process gives us full control and
 * lets us emit the codeam-cli-compatible SSE chunk stream the mobile
 * client already knows how to render.
 */
const PYTHON_PTY_HELPER = `import os,pty,sys,select,signal,struct,fcntl,termios,errno
m,s=pty.openpty()
try:
    cols=int(os.environ.get('COLUMNS','220'))
    rows=int(os.environ.get('LINES','50'))
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
def onwinch(n,f):
    try:
        cols=int(os.environ.get('COLUMNS','220'))
        rows=int(os.environ.get('LINES','50'))
        fcntl.ioctl(m,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
    except Exception:pass
signal.signal(signal.SIGCHLD,onchld)
signal.signal(signal.SIGWINCH,onwinch)
i=sys.stdin.fileno()
o=sys.stdout.fileno()
while not done[0]:
    try:r,_,_=select.select([i,m],[],[],0.1)
    except OSError as e:
        if e.errno==errno.EINTR:continue
        break
    if i in r:
        try:
            d=os.read(i,4096)
            if d:os.write(m,d)
            else:break
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
 * apps/cli/src/services/claude.service.ts so the plugin produces the
 * exact same keystroke timing (React Ink batching is a real footgun).
 */
export class ClaudePtyService {
  private proc: ChildProcess | null = null;
  private helperPath: string | null = null;
  private cols: number;
  private rows: number;

  constructor(private readonly opts: ClaudePtyOptions) {
    this.cols = opts.cols ?? 220;
    this.rows = opts.rows ?? 50;
  }

  /** Launch `claude` under a Python PTY helper. Returns false if claude or python3 is missing. */
  spawn(): boolean {
    const claudeCmd = findInPath('claude') ?? findInPath('claude-code');
    if (!claudeCmd) return false;

    const python = findInPath('python3') ?? findInPath('python');
    if (!python) {
      // No Python available — fall back to direct spawn (no real PTY, limited interactive support).
      return this.spawnDirect(claudeCmd);
    }

    const shell = process.env.SHELL || '/bin/sh';
    this.helperPath = path.join(os.tmpdir(), `codeagent-vsc-pty-${process.pid}.py`);
    try {
      fs.writeFileSync(this.helperPath, PYTHON_PTY_HELPER, { mode: 0o644 });
    } catch (e) {
      return this.spawnDirect(claudeCmd);
    }

    this.proc = spawn(python, [this.helperPath, shell, '-c', `exec ${claudeCmd}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.opts.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLUMNS: String(this.cols),
        LINES: String(this.rows),
      },
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.opts.onData(chunk.toString('utf8'));
    });
    // Keep stderr readable for debugging but don't forward to the terminal.
    this.proc.stderr?.on('data', () => { /* noop */ });

    this.proc.on('error', () => {
      this.cleanup();
      this.opts.onExit(1);
    });
    this.proc.on('exit', (code) => {
      this.cleanup();
      this.opts.onExit(code ?? 0);
    });

    return true;
  }

  private spawnDirect(claudeCmd: string): boolean {
    this.proc = spawn(claudeCmd, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.opts.cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
      shell: false,
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.opts.onData(chunk.toString('utf8'));
    });
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      this.opts.onData(chunk.toString('utf8'));
    });

    this.proc.on('exit', (code) => {
      this.cleanup();
      this.opts.onExit(code ?? 0);
    });
    return true;
  }

  /** Raw write to the PTY master — used by Pseudoterminal.handleInput. */
  write(data: string | Buffer): void {
    this.proc?.stdin?.write(data);
  }

  /**
   * Send a command from a remote source (mobile). Splits the submit Enter
   * into a separate write 50 ms later so React Ink has time to flush the
   * text into input state — otherwise the Enter lands in the same
   * synchronous run and submits an empty input.
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

  /** Update terminal size — forwarded to the PTY via SIGWINCH on the helper. */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (!this.proc?.pid) return;
    try {
      process.env.COLUMNS = String(cols);
      process.env.LINES = String(rows);
      // Signal helper so it refreshes the inner PTY dimensions.
      process.kill(this.proc.pid, 'SIGWINCH');
    } catch { /* ignore */ }
  }

  kill(): void {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      proc.removeAllListeners('exit');
      try { proc.kill(); } catch { /* ignore */ }
    }
    this.cleanup();
  }

  isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  private cleanup(): void {
    if (this.helperPath) {
      try { fs.unlinkSync(this.helperPath); } catch { /* ignore */ }
      this.helperPath = null;
    }
  }
}

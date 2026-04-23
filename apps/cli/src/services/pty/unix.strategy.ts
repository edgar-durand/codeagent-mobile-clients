import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IPtyStrategy, PtyStrategyOptions, findInPath } from './types';

/**
 * Python 3 PTY helper — written to a temp file at runtime.
 *
 * Why Python instead of `script`:
 *   `script` calls tcgetattr(STDIN_FILENO) which fails when stdin is a pipe or
 *   socket (e.g. inside Claude Code's integrated terminal).
 *   Python's pty.openpty() creates the PTY pair directly at OS level without
 *   requiring the parent's stdin to be a terminal.
 *
 * What it does:
 *   1. Opens a PTY pair (master / slave)
 *   2. Forks; child execs the command with PTY slave as stdin/stdout/stderr
 *      → Claude Code sees stdin.isTTY === true, no "no stdin data" warning
 *   3. Parent select()-loops, relaying:
 *      stdin (pipe from Node)  → PTY master  → Claude  (mobile command injection)
 *      PTY master (Claude out) → stdout pipe → Node    (output capture for mobile)
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
        sz=os.get_terminal_size(2)
        fcntl.ioctl(m,termios.TIOCSWINSZ,struct.pack('HHHH',sz.lines,sz.columns,0,0))
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

/**
 * macOS / Linux PTY strategy.
 *
 * Uses a Python PTY helper to give Claude a real TTY so that
 * stdin.isTTY === true and interactive selectors work correctly.
 * Falls back to a direct spawn (no PTY) if python3 is unavailable.
 */
export class UnixPtyStrategy implements IPtyStrategy {
  private proc: ChildProcess | null = null;
  private helperPath: string | null = null;

  constructor(private readonly opts: PtyStrategyOptions) {}

  spawn(cmd: string, cwd: string, args: string[] = []): void {
    const python = findInPath('python3') ?? findInPath('python');
    if (!python) {
      // No Python available — fall back to direct spawn with a note
      console.error(
        '  · python3 not found; mobile command injection may be limited.\n',
      );
      this.spawnDirect(cmd, cwd, args);
      return;
    }

    const shell = process.env.SHELL || '/bin/sh';
    const cols = process.stdout.columns || 220;
    const rows = process.stdout.rows || 50;

    // Write helper to a fixed temp path (overwrite is safe — single process at a time)
    this.helperPath = path.join(os.tmpdir(), 'codeam-pty-helper.py');
    fs.writeFileSync(this.helperPath, PYTHON_PTY_HELPER, { mode: 0o644 });

    const fullCmd = args.length > 0 ? `${cmd} ${args.join(' ')}` : cmd;
    this.proc = spawn(python, [this.helperPath, shell, '-c', `exec ${fullCmd}`], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLUMNS: String(cols),
        LINES: String(rows),
      },
    });

    this.proc.on('error', (err) => {
      console.error(
        `\n  ✗ Failed to launch Claude Code: ${err.message}\n` +
          '    Make sure claude is correctly installed: npm install -g @anthropic-ai/claude-code\n',
      );
      process.exit(1);
    });

    // Forward Claude's PTY output to our terminal and to the output service
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      this.opts.onData(chunk.toString('utf8'));
    });

    // Forward user keystrokes → Python helper's stdin → PTY master → Claude
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this.stdinHandler);

    process.on('SIGWINCH', this.handleResize);

    this.proc.on('exit', (code) => {
      this.removeTempFile();
      this.dispose();
      this.opts.onExit(code ?? 0);
    });
  }

  /**
   * Python-unavailable fallback: direct spawn without PTY.
   * Mobile command injection is limited (no real TTY for Claude).
   */
  private spawnDirect(cmd: string, cwd: string, args: string[] = []): void {
    this.proc = spawn(cmd, args, {
      stdio: ['pipe', 'inherit', 'inherit'],
      cwd,
      env: process.env,
      shell: true,
    });

    this.proc.on('error', (err) => {
      console.error(
        `\n  ✗ Failed to launch Claude Code: ${err.message}\n` +
          '    Make sure claude is correctly installed: npm install -g @anthropic-ai/claude-code\n',
      );
      process.exit(1);
    });

    // Poke stdin so Claude doesn't immediately drop into no-stdin mode
    this.proc.stdin?.write('');

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this.stdinHandler);

    process.on('SIGWINCH', this.handleResize);

    this.proc.on('exit', (code) => {
      this.dispose();
      this.opts.onExit(code ?? 0);
    });
  }

  write(data: string | Buffer): void {
    this.proc?.stdin?.write(data);
  }

  kill(): void {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      proc.removeAllListeners('exit'); // prevent old exit handler from deleting the new helper file
      proc.kill();
    }
    this.removeTempFile();
    this.dispose();
  }

  dispose(): void {
    process.removeListener('SIGWINCH', this.handleResize);
    process.stdin.removeListener('data', this.stdinHandler);
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
  }

  private stdinHandler = (chunk: Buffer): void => {
    this.proc?.stdin?.write(chunk);
  };

  private handleResize = (): void => {
    if (this.proc?.pid) {
      try { process.kill(this.proc.pid, 'SIGWINCH'); } catch { /* ignore */ }
    }
  };

  private removeTempFile(): void {
    if (this.helperPath) {
      try { fs.unlinkSync(this.helperPath); } catch { /* ignore */ }
      this.helperPath = null;
    }
  }
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { findInPath } from '../../services/pty/types';
import type { HistoryService } from '../../services/history.service';

/**
 * Background `/usage` probe — spawns a separate, short-lived Claude
 * Code process under a Python PTY helper so we can ask it for the
 * weekly quota + reset window without disturbing the active turn.
 *
 * Why not use the in-flight Claude PTY: that one's owned by the
 * user's interactive session — feeding it `/usage` would drop the
 * slash command into whatever they were typing. Spawning a side
 * process that exits ~12 s later avoids that.
 *
 * macOS / Linux only. The helper uses `os.fork`, `pty.openpty`,
 * `fcntl.ioctl(TIOCSWINSZ)` — all Unix-only — and gracefully
 * no-ops on Windows where Python may not be on PATH or those
 * modules may import-fail.
 */

/** Set to `true` while a fetch is in flight; prevents reentry. */
let inProgress = false;

const HELPER_SCRIPT = `import os,pty,sys,select,signal,struct,fcntl,termios,errno
m,s=pty.openpty()
try:
    fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',30,120,0,0))
except Exception:pass
pid=os.fork()
if pid==0:
    os.close(m);os.setsid()
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
i=sys.stdin.fileno();o=sys.stdout.fileno()
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

export function fetchQuotaUsage(historySvc: HistoryService): void {
  if (inProgress) return;
  inProgress = true;

  const claudeCmd = findInPath('claude') ? 'claude' : 'claude-code';
  if (!claudeCmd) { inProgress = false; return; }

  const helperPath = path.join(os.tmpdir(), 'codeam-quota-helper.py');
  fs.writeFileSync(helperPath, HELPER_SCRIPT, { mode: 0o644 });

  const python = findInPath('python3') ?? findInPath('python');
  if (!python) { inProgress = false; return; }

  const proc = spawn(python, [helperPath, claudeCmd, '--tools', ''], {
    stdio: ['pipe', 'pipe', 'ignore'],
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'dumb', COLUMNS: '120', LINES: '30' },
  });

  let output = '';
  proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });

  // Sequence: give Claude enough time to boot under PTY (auth +
  // hooks), then fire `/usage`, then parse the rendered response.
  setTimeout(() => {
    proc.stdin?.write('/usage\r');
    setTimeout(() => {
      const clean = output
        .replace(/\x1B\[[^@-~]*[@-~]/g, '')
        .replace(/[\x00-\x1F\x7F]/g, ' ')
        .replace(/\s+/g, ' ');
      const weekMatch = clean.match(/(\d+)%\s*used/i) || clean.match(/(\d+)\s*%/);
      if (weekMatch) historySvc.setQuotaPercent(parseInt(weekMatch[1], 10));
      const resetMatch = clean.match(/resets\s+(.+?)(?:\s*\(|$)/im);
      if (resetMatch) historySvc.setRateLimitReset(resetMatch[1].trim());
      try { proc.kill(); } catch { /* already gone */ }
      try { fs.unlinkSync(helperPath); } catch { /* ignore */ }
      inProgress = false;
    }, 5000);
  }, 8000);

  proc.on('exit', () => { inProgress = false; });
  // Safety hatch — kill after 20 s in case the helper gets stuck.
  setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 20000);
}

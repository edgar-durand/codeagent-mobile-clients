import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PYTHON_PTY_HELPER } from '../../src/services/pty/unix.strategy';

/**
 * The Python PTY helper must FORWARD SIGTERM to the agent it wraps and stay
 * alive until that agent has exited.
 *
 * Until 2026-09-24 it had no SIGTERM handler: `kill()` terminated the helper
 * and left the agent orphaned. On a baton hand-off / in the baton
 * integration suite, the orphaned Claude exited a beat later and rewrote
 * `~/.claude.json` from memory, clobbering the workspace-trust entry the next
 * session had just written — which then wedged on the trust dialog for 180 s
 * (clients CI run 35946818546).
 */
const hasPython = (() => {
  try {
    execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const childPidsOf = (pid: number): number[] => {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
};

const waitFor = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
};

describe.skipIf(process.platform === 'win32' || !hasPython)('unix PTY helper — SIGTERM', () => {
  it('forwards SIGTERM to the wrapped agent and exits only after the agent is gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-pty-helper-'));
    const helper = path.join(dir, 'helper.py');
    fs.writeFileSync(helper, PYTHON_PTY_HELPER);
    // `sleep` ignores nothing and exits on SIGTERM — a stand-in for the agent.
    const proc = spawn('python3', [helper, 'sleep', '30'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.once('exit', (code, signal) => resolve({ code, signal })),
    );
    try {
      expect(await waitFor(() => childPidsOf(proc.pid!).length > 0, 3_000)).toBe(true);
      const [agentPid] = childPidsOf(proc.pid!);
      expect(alive(agentPid)).toBe(true);

      proc.kill('SIGTERM');
      const res = await Promise.race([
        exit,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 4_000)),
      ]);
      expect(res).not.toBe('timeout');
      // The helper exited by itself (handler → forward → waitpid), not under the signal.
      expect((res as { signal: NodeJS.Signals | null }).signal).toBeNull();
      // And the agent it wrapped is gone with it — no orphan.
      expect(await waitFor(() => !alive(agentPid), 1_000)).toBe(true);
    } finally {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

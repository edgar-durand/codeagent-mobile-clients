import { spawn } from 'child_process';
import { log } from '../logger';

export type SetupRunResult =
  | { status: 'ok'; code: 0 }
  | { status: 'failed'; code: number | null }
  | { status: 'timeout'; code: null };

/**
 * Run a single preview setup command (e.g. `pnpm install`,
 * `prisma generate`) detached from the CLI's stdout, time-bounded by
 * `opts.timeoutMs`.
 *
 * Output is captured to the `[preview]` log so it stays debuggable, but
 * the host terminal stays clean — the user's `codeam pair` session
 * shouldn't fill up with `npm WARN` lines every time they tap Start
 * Preview (the "contaminated terminal" report).
 *
 * The timeout is the BUG-1 fix: a fresh codespace with no
 * `node_modules/` runs a full install before the dev server can spawn.
 * If that install stalls (hung registry fetch, a lockfile prompt
 * waiting on stdin that never comes, a network black hole) the dev
 * server never starts and the user waits on the preview spinner
 * forever. Bounding it lets the caller surface a `preview_error`
 * instead of hanging — we kill the child and report `timeout`.
 */
export function runSetupCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> | undefined,
  opts: { timeoutMs: number },
): Promise<SetupRunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const tag = `setup:${cmd}`;
    const onChunk = (chunk: Buffer): void => {
      // Trim trailing newlines so each captured chunk lands as one log
      // line. Empty payloads (just `\n`) get dropped.
      const text = chunk.toString().replace(/\n+$/g, '');
      if (text.length === 0) return;
      log.info('preview', `${tag}: ${text}`);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.info('preview', `${tag}: timed out after ${opts.timeoutMs}ms — killing`);
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      resolve({ status: 'timeout', code: null });
    }, opts.timeoutMs);

    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ status: 'ok', code: 0 });
      else resolve({ status: 'failed', code });
    });
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: 'failed', code: null });
    });
  });
}

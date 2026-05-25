import { spawn } from 'child_process';

/**
 * Spawn a child process, collect its stdout to a string, kill it on
 * timeout, and resolve with the captured text. Returns `null` on any
 * failure path (spawn error, non-zero exit, timeout, empty output)
 * so callers can branch on the absence of a result without
 * try/catch.
 *
 * Used by the per-agent `generateOneShot` strategy methods to run
 * the agent in its headless one-shot mode (`claude -p "..."`,
 * `codex exec "..."`) and capture the AI summary / insight text.
 *
 * stderr is captured but only surfaced via `onStderr` for debug
 * logging — it never short-circuits the result, because some agents
 * write progress chatter to stderr while still returning a valid
 * response on stdout.
 */
export interface SpawnAndCaptureOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onStderr?: (chunk: string) => void;
}

export async function spawnAndCapture(
  cmd: string,
  args: ReadonlyArray<string>,
  opts: SpawnAndCaptureOpts = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn(cmd, [...args], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      settle(null);
      return;
    }

    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      opts.onStderr?.(chunk.toString('utf8'));
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // swallow — child may have already exited
      }
      settle(null);
    }, timeoutMs);
    timer.unref();

    child.on('error', () => {
      clearTimeout(timer);
      settle(null);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle(null);
        return;
      }
      const trimmed = stdout.trim();
      settle(trimmed.length > 0 ? trimmed : null);
    });
  });
}

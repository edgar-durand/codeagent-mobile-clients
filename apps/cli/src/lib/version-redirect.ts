// src/lib/version-redirect.ts
//
// Launcher redirect onto the versioned install (`lib/cli-versions.ts`).
//
// Whatever `codeam` a box launches — the Box image's global `/usr/local/bin`,
// the bundled-node `/tmp/codeam-node20/bin`, `~/.local/bin`, or the fixed
// ExecStart of a self-hosted systemd unit — the process first checks
// `~/.codeam/cli/current`. When that is a STRICTLY newer, runnable version it
// runs it as a child (stdio inherited, signals forwarded, exit code passed
// through) instead of itself. So the self-update never has to touch PATH, a
// systemd unit or the global npm prefix: switching `current` is the whole
// deploy, and the next start of ANY entry point lands on it.
//
// Rollback: if a redirected `host-agent` dies with a non-zero exit within
// CRASH_WINDOW_MS of starting, the launcher flips `current` back to `previous`
// and starts again (the previous version, or itself) — a broken release can't
// take a box down.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { cliVersionsRoot, redirectTarget, rollbackCurrent } from './cli-versions';

declare const __CLI_VERSION__: string;

/** A redirected host-agent that exits non-zero this soon is treated as broken. */
export const CRASH_WINDOW_MS = 15_000;

const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];

export interface RedirectDeps {
  ownVersion: string | null;
  root: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  execPath: string;
  now: () => number;
  spawn: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  /** Called with the final exit code once a redirected child is done. */
  exit: (code: number) => void;
  warn: (msg: string) => void;
}

function defaultDeps(): RedirectDeps {
  return {
    ownVersion: typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : null,
    root: cliVersionsRoot(),
    argv: process.argv,
    env: process.env,
    execPath: process.execPath,
    now: () => Date.now(),
    spawn: (cmd, args, env) => nodeSpawn(cmd, args, { stdio: 'inherit', env }),
    exit: (code) => process.exit(code),
    warn: (msg) => process.stderr.write(`${msg}\n`),
  };
}

/**
 * Run the newer versioned install instead of this process when there is one.
 * Resolves `'self'` when THIS process should carry on with its own command;
 * otherwise hands over and finishes through `deps.exit` with the child's code.
 */
export async function maybeRedirectToVersioned(
  over: Partial<RedirectDeps> = {},
): Promise<'self' | 'redirected'> {
  const deps = { ...defaultDeps(), ...over };
  if (deps.env.CODEAM_CLI_REDIRECTED === '1' || deps.env.CODEAM_NO_VERSION_REDIRECT === '1') {
    return 'self';
  }
  const isHostAgent = deps.argv[2] === 'host-agent';
  let rolledBack = false;

  for (;;) {
    const entry = redirectTarget(deps.root, deps.ownVersion);
    if (!entry) return 'self';

    const startedAt = deps.now();
    const child = deps.spawn(deps.execPath, [entry, ...deps.argv.slice(2)], {
      ...deps.env,
      CODEAM_CLI_REDIRECTED: '1',
      // The child must behave as the box's top process would: a pid-1 launcher
      // (CodeAgent Box container) means "just exit, the container restarts".
      ...(process.pid === 1 ? { CODEAM_LAUNCHER_IS_PID1: '1' } : {}),
    });
    const forward = (sig: NodeJS.Signals) => () => {
      try {
        child.kill(sig);
      } catch {
        /* child already gone */
      }
    };
    const handlers = FORWARDED_SIGNALS.map((sig) => [sig, forward(sig)] as const);
    for (const [sig, h] of handlers) process.on(sig, h);

    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('exit', (c, s) => resolve({ code: c, signal: s }));
        child.once('error', () => resolve({ code: 1, signal: null }));
      },
    );
    for (const [sig, h] of handlers) process.off(sig, h);

    const crashedEarly =
      isHostAgent && signal === null && code !== 0 && deps.now() - startedAt < CRASH_WINDOW_MS;
    if (crashedEarly) {
      // ONE rollback at most (no current↔previous ping-pong); after that, or
      // with nothing to roll back to, the launcher runs its own version.
      const now = rolledBack ? null : rollbackCurrent(deps.root);
      deps.warn(
        `codeam: ${entry} exited ${String(code)} within ${CRASH_WINDOW_MS / 1000}s — ` +
          (now ? `rolled back to ${now}` : 'running the launcher\'s own version instead'),
      );
      if (!now) return 'self';
      rolledBack = true;
      continue; // start the rolled-back `current` if it is still newer than us
    }
    deps.exit(code ?? 1);
    return 'redirected';
  }
}

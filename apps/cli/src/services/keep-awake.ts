// src/services/keep-awake.ts
//
// Keep the user's machine awake while a LOCAL session is active. A local
// `codeam` session is a long-running process the paired mobile app talks to; if
// the laptop goes to idle/system sleep the process is frozen and the mobile side
// drops the session until the user physically wakes the machine. We hold an
// OS-native power assertion for the CLI's lifetime so an active session survives
// an idle laptop.
//
// The per-OS "prevent sleep" command lives on the OS STRATEGY
// (`os/strategy.ts` → `keepAwakeCommand(pid)`: caffeinate / systemd-inhibit /
// SetThreadExecutionState) so the platform knowledge stays in one ordered place.
// This service owns only the lifecycle: gate → spawn (best-effort) → dispose.
//
// Best-effort EVERYWHERE: if the helper binary is absent (a stripped container,
// a non-systemd Linux, PowerShell missing) the spawn 'error' is swallowed and the
// session runs exactly as before — this only ever ADDS "don't sleep", never gates
// the session. Gated to LOCAL sessions (a codespace / self-hosted box isn't the
// user's laptop) and opt-out-able via `CODEAM_NO_KEEP_AWAKE=1`.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { log } from './logger';
import { isLocalSession } from '../baton/gate';
import { createOsStrategy } from '../os';
import type { KeepAwakeCommand } from '../os/strategy';

export interface KeepAwakeDeps {
  pid?: number;
  env?: NodeJS.ProcessEnv;
  isLocal?: boolean;
  /** The OS-native command; defaults to the host OS strategy. Injectable so a
   *  test drives any platform's argv without touching `process.platform`. */
  command?: KeepAwakeCommand | null;
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
}

/**
 * Start holding the machine awake for a LOCAL session. Returns a disposer that
 * stops it (safe to call multiple times). No-op — returning a no-op disposer —
 * when: not a local session, opted out (`CODEAM_NO_KEEP_AWAKE=1`), or the OS
 * exposes no such mechanism. Never throws.
 */
export function keepDeviceAwake(deps: KeepAwakeDeps = {}): () => void {
  const env = deps.env ?? process.env;
  const isLocal = deps.isLocal ?? isLocalSession(env);
  const noop = (): void => {};

  if (!isLocal) return noop;
  if (env.CODEAM_NO_KEEP_AWAKE === '1') return noop;

  const command =
    deps.command !== undefined
      ? deps.command
      : createOsStrategy().keepAwakeCommand(deps.pid ?? process.pid);
  if (!command) return noop;

  const spawnFn = deps.spawnFn ?? spawn;
  let child: ChildProcess | null = null;
  try {
    child = spawnFn(command.cmd, command.args, { stdio: 'ignore', detached: true });
    // The helper binary may be absent (non-systemd Linux, no PowerShell, a
    // stripped image). spawn emits that as an ASYNC 'error' event — swallow it;
    // the session is unaffected.
    child.once('error', () => {
      /* best-effort — keep-awake is a pure enhancement */
    });
    // Don't let the assertion holder keep OUR event loop alive on its own.
    child.unref();
    log.info('keep-awake', `holding a power assertion for this local session (${command.cmd})`);
  } catch {
    child = null;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (child && child.pid && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    child = null;
  };
}

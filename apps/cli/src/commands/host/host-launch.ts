// src/commands/host/host-launch.ts
//
// How the HOST-AGENT (and only the host-agent) gets onto the versioned install
// (`lib/cli-versions.ts`, codeagent-siec).
//
// Two mechanisms, both scoped to `codeam host-agent`:
//
//  1. `hostEntry()` — every session / pair-auto child the supervisor spawns, and
//     the self-relaunch after an update, run `node <current entry>` (never a
//     stale `process.argv[1]`). The relaunched process IS `current`, so its
//     startup check finds nothing newer: no restart loop across releases.
//
//  2. `superviseCurrent()` — when the host-agent was started from an OLDER
//     binary than a valid `current` (the systemd unit's / Box image's / codespace
//     wake's global `codeam`), it hops ONCE: it stays as a thin parent that runs
//     `node <current entry> host-agent --supervised` and respawns it when it
//     exits 0 after a self-update. The child never relaunches itself in that
//     mode. A child that dies BEFORE signalling ready (first successful
//     heartbeat, via IPC) marks its release `.bad` and rolls back; an expected
//     exit (EXIT_HOST_NOT_ENROLLED) is passed through untouched.
//
// Nothing here runs for any other command: a local user's `codeam start`,
// `pair`, MCP stdio servers, the TUI — all run exactly the binary launched.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { log } from '../../services/logger';
import { compareSemver } from '../../lib/updateNotifier';
import {
  cliVersionsRoot,
  hostEntry,
  markBad,
  rollbackCurrent,
  validCurrent,
  versionedModeSupported,
} from '../../lib/cli-versions';
import { EXIT_HOST_NOT_ENROLLED } from '../../exit-codes';
import { currentCliVersion } from './self-update';

/** argv flag the parent passes its child (argv, not env: nothing leaks to agents/MCP). */
export const SUPERVISED_FLAG = '--supervised';
/** IPC message the supervised child sends once its first heartbeat succeeded. */
export const READY_MESSAGE = 'codeam-host-ready';
/** More than this many respawns in a row, each within FAST_EXIT_MS, stops the loop. */
const MAX_FAST_RESPAWNS = 5;
const FAST_EXIT_MS = 30_000;

/** Tell a supervising parent (if any) that this host-agent is up. Idempotent. */
let readySent = false;
export function signalHostReady(send: ((m: unknown) => void) | undefined = process.send?.bind(process)): void {
  if (readySent || !send) return;
  readySent = true;
  try {
    send(READY_MESSAGE);
  } catch {
    /* parent gone — nothing to tell */
  }
}

export interface SuperviseDeps {
  ownVersion: string | null;
  root: string;
  args: string[];
  execPath: string;
  platform: NodeJS.Platform;
  now: () => number;
  spawn: (cmd: string, args: string[]) => ChildProcess;
  exit: (code: number) => void;
  /** Re-raise a signal on this process (so the shell/systemd sees the real cause). */
  reraise: (signal: NodeJS.Signals) => void;
  warn: (msg: string) => void;
  /** Whether a terminal SIGINT also reaches the child directly (same process group). */
  stdinIsTty: boolean;
}

function defaultDeps(): SuperviseDeps {
  return {
    ownVersion: typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : null,
    root: cliVersionsRoot(),
    args: process.argv.slice(3),
    execPath: process.execPath,
    platform: process.platform,
    now: () => Date.now(),
    spawn: (cmd, args) => nodeSpawn(cmd, args, { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] }),
    exit: (code) => process.exit(code),
    reraise: (signal) => {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    },
    warn: (msg) => process.stderr.write(`${msg}\n`),
    stdinIsTty: Boolean(process.stdin.isTTY),
  };
}

declare const __CLI_VERSION__: string;

/**
 * Run the host-agent from a newer valid `current`, supervising it. Resolves
 * `'self'` when this process should run the host-agent itself (no newer
 * current, Windows, already supervised, or every newer release turned out bad);
 * otherwise never resolves — it ends the process with the child's outcome.
 */
export async function superviseCurrent(over: Partial<SuperviseDeps> = {}): Promise<'self' | 'supervised'> {
  const deps = { ...defaultDeps(), ...over };
  if (!versionedModeSupported(deps.platform) || deps.args.includes(SUPERVISED_FLAG)) return 'self';
  let fastRespawns = 0;

  for (;;) {
    const cur = validCurrent(deps.root);
    if (!cur || !deps.ownVersion || compareSemver(cur.version, deps.ownVersion) <= 0) return 'self';

    const startedAt = deps.now();
    let ready = false;
    let stopping = false;
    const child = deps.spawn(deps.execPath, [cur.entry, 'host-agent', SUPERVISED_FLAG, ...deps.args]);
    child.on('message', (m: unknown) => {
      if (m === READY_MESSAGE) ready = true;
    });
    const signals: NodeJS.Signals[] = deps.stdinIsTty ? ['SIGTERM', 'SIGHUP'] : ['SIGTERM', 'SIGHUP', 'SIGINT'];
    const forward = (sig: NodeJS.Signals) => (): void => {
      stopping = true;
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const handlers = signals.map((sig) => [sig, forward(sig)] as const);
    for (const [sig, h] of handlers) process.on(sig, h);
    // In a TTY the terminal's SIGINT reaches the child itself; just don't die first.
    const ignoreSigint = (): void => {
      stopping = true;
    };
    if (deps.stdinIsTty) process.on('SIGINT', ignoreSigint);

    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('exit', (c, s) => resolve({ code: c, signal: s }));
        child.once('error', () => resolve({ code: 1, signal: null }));
      },
    );
    for (const [sig, h] of handlers) process.off(sig, h);
    if (deps.stdinIsTty) process.off('SIGINT', ignoreSigint);

    if (signal) {
      deps.reraise(signal);
      return 'supervised';
    }
    if (stopping || code === EXIT_HOST_NOT_ENROLLED) {
      deps.exit(code ?? 1);
      return 'supervised';
    }
    if (code === 0) {
      // Self-update restart: respawn onto the (new) current — bounded.
      fastRespawns = deps.now() - startedAt < FAST_EXIT_MS ? fastRespawns + 1 : 0;
      if (fastRespawns > MAX_FAST_RESPAWNS) {
        deps.warn('codeam: host-agent keeps restarting — running the launcher’s own version');
        return 'self';
      }
      continue;
    }
    if (!ready) {
      // Died before it ever got its first heartbeat through: a broken release.
      markBad(cur.dir, `host-agent exited ${String(code)} before ready`);
      const now = rollbackCurrent(deps.root);
      deps.warn(
        `codeam: ${cur.version} exited ${String(code)} before ready — marked bad` +
          (now ? `, rolled back to ${now}` : ''),
      );
      continue; // re-resolve: the rolled-back current, or 'self'
    }
    deps.exit(code ?? 1);
    return 'supervised';
  }
}

/**
 * True when nothing will start this process again once it exits: not a systemd
 * unit (systemd sets `INVOCATION_ID` for every unit it runs) and not a
 * container's pid 1 (whose exit is the container's restart policy's call).
 * That is a codespace, where the host-agent is launched with `setsid nohup`.
 */
export function needsSelfRelaunch(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): boolean {
  return !env.INVOCATION_ID && pid !== 1;
}

/**
 * Start a fresh host-agent on the freshly-installed binary, detached, after a
 * 2 s pause. The pause lets THIS process exit first, so the new boot resume
 * sees this supervisor's session children re-parented to init and retires them
 * (see `orphanedSupervisorDaemon`) instead of deferring to them.
 */
export function relaunchArgv(execPath: string, argv: string[]): string[] {
  return ['-c', 'sleep 2; exec "$0" "$@"', execPath, ...argv.slice(1)];
}

/**
 * Restart after a self-update.
 * - Supervised (`--supervised`, a parent from `superviseCurrent` owns us): just
 *   exit 0 — the parent respawns the new `current`.
 * - systemd / container pid 1: exit; the unit / restart policy starts the
 *   global `codeam host-agent`, which hops onto `current` (superviseCurrent).
 * - No supervisor at all (codespace): relaunch ourselves onto the CURRENT
 *   version's entry — never a stale `process.argv[1]`. Re-exec'ing argv[1]
 *   (an older versioned dir) made the relaunched process see a newer
 *   `current` on its startup check and restart again, forever (review P0).
 */
export function defaultRestartForUpdate(
  version: string,
  supervised: boolean,
  io: {
    entry?: string;
    root?: string;
    ownVersion?: string | null;
    argv1?: string;
    relaunch?: (argv: string[]) => void;
    exit?: (code: number) => void;
    needsRelaunch?: boolean;
  } = {},
): void {
  const exit = io.exit ?? ((code: number) => process.exit(code));
  const relaunch = !supervised && (io.needsRelaunch ?? needsSelfRelaunch());
  log.info(
    'host-agent',
    `self-update: installed ${version}, restarting${supervised ? ' (supervised)' : relaunch ? ' (self-relaunch, no supervisor)' : ''}`,
  );
  if (relaunch) {
    const entry =
      io.entry ??
      hostEntry(
        io.root ?? cliVersionsRoot(),
        io.ownVersion === undefined ? currentCliVersion() : io.ownVersion,
        io.argv1 ?? process.argv[1] ?? '',
      );
    const argv = [process.argv[0] ?? process.execPath, entry, ...process.argv.slice(2)];
    try {
      (io.relaunch ??
        ((a: string[]) =>
          nodeSpawn('/bin/sh', relaunchArgv(process.execPath, a), {
            cwd: process.cwd(),
            env: process.env,
            detached: true,
            stdio: 'ignore',
          }).unref()))(argv);
    } catch (err) {
      log.error('host-agent', 'self-update: relaunch failed — staying on the old binary', err);
      return;
    }
  }
  exit(0);
}

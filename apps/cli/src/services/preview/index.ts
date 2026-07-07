import type { ChildProcess } from 'child_process';
import type { PreviewDetection } from '@codeam/shared';

export * from './cloudflared';
export * from './codespace';
export * from './config-file';
export * from './dotenv';
export * from './parser';
export * from './port-ready';
export * from './provision-deps';
export * from './run-setup';
export * from './setup-deps';
export * from './tunnel-bringup';

/**
 * One running preview slot, keyed by sessionId. The plugin process is
 * the source of truth — when this map is empty for a session, the
 * preview is stopped. The Redis snapshot on the backend mirrors the
 * latest state but never the running child processes themselves.
 */
export interface ActivePreview {
  sessionId: string;
  devServer: ChildProcess;
  /** Null when the framework manages its own tunnel (Expo / codespace). */
  tunnel: ChildProcess | null;
  url: string;
  framework: string;
  /** The detection this preview was started from, so a restart can
   *  re-spawn it without re-reading `.codeam/preview.json`. */
  detection: PreviewDetection;
}

export const activePreviews = new Map<string, ActivePreview>();

export function registerPreview(sessionId: string, preview: ActivePreview): void {
  activePreviews.set(sessionId, preview);
}

/**
 * SIGTERM (or SIGKILL) a child process AND its whole process group.
 *
 * Dev servers (vite / next / expo) fork worker children that are the
 * processes actually `listen()`-ing on the port. `child.kill()` signals
 * ONLY the direct child, orphaning those workers — they keep the port
 * bound, so the next `preview_start` for the same session hits
 * EADDRINUSE on a port THIS process already leaked (the bug this guards
 * against). When the child was spawned `detached` (POSIX), it is its own
 * process-group leader and `process.kill(-pid, signal)` signals every
 * member of the group, so the workers die with it.
 *
 * Falls back to a direct `child.kill` on Windows (no POSIX process
 * groups) and when the group signal throws (leader already gone).
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  const pid = child.pid;
  if (pid == null) return;
  if (process.platform !== 'win32') {
    try {
      // Negative pid → the whole process group (child spawned detached).
      process.kill(-pid, signal);
      return;
    } catch {
      // Group already gone, or the child wasn't a group leader — fall
      // through to a best-effort direct kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already dead
  }
}

/**
 * Kill the preview for a session. Order matters: the tunnel goes
 * first so cloudflared cleanly disconnects upstream before the local
 * port stops responding — otherwise the public URL serves 502s for
 * the few seconds it takes the edge to expire the tunnel record.
 *
 * 100 ms grace between tunnel SIGTERM and dev-server SIGTERM. 250 ms
 * later, SIGKILL anything that refused to exit cleanly. Both kills go
 * to the whole process group (see `killProcessTree`) so the dev
 * server's worker children don't outlive it and leak the port.
 */
export async function killPreview(sessionId: string): Promise<void> {
  const preview = activePreviews.get(sessionId);
  if (!preview) return;

  if (preview.tunnel) {
    killProcessTree(preview.tunnel, 'SIGTERM');
  }
  await new Promise((r) => setTimeout(r, 100));
  killProcessTree(preview.devServer, 'SIGTERM');

  const sigkillTimer = setTimeout(() => {
    killProcessTree(preview.devServer, 'SIGKILL');
    if (preview.tunnel) killProcessTree(preview.tunnel, 'SIGKILL');
  }, 250);
  // Don't block process exit on this safety timer.
  sigkillTimer.unref?.();

  activePreviews.delete(sessionId);
}

/** Walks every active preview, killing each one. Called from the
 *  CLI's sigintHandler on session end so the dev servers + tunnels
 *  don't outlive the parent process. */
export async function killAllPreviews(): Promise<void> {
  const ids = Array.from(activePreviews.keys());
  await Promise.all(ids.map((id) => killPreview(id)));
}

/**
 * Snapshot the active preview ids BEFORE killAllPreviews drains the
 * registry. The sigintHandler needs this list to emit a
 * `preview_stopped` event per session AFTER the local processes are
 * dead — otherwise the mobile / web dashboard keeps showing the
 * preview as running until the Redis TTL expires (1 h).
 */
export function activePreviewSessionIds(): string[] {
  return Array.from(activePreviews.keys());
}

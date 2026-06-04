import type { ChildProcess } from 'child_process';

export * from './cloudflared';
export * from './codespace';
export * from './config-file';
export * from './parser';
export * from './setup-deps';

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
}

export const activePreviews = new Map<string, ActivePreview>();

export function registerPreview(sessionId: string, preview: ActivePreview): void {
  activePreviews.set(sessionId, preview);
}

/**
 * Kill the preview for a session. Order matters: the tunnel goes
 * first so cloudflared cleanly disconnects upstream before the local
 * port stops responding — otherwise the public URL serves 502s for
 * the few seconds it takes the edge to expire the tunnel record.
 *
 * 100 ms grace between tunnel SIGTERM and dev-server SIGTERM. 250 ms
 * later, SIGKILL anything that refused to exit cleanly.
 */
export async function killPreview(sessionId: string): Promise<void> {
  const preview = activePreviews.get(sessionId);
  if (!preview) return;

  if (preview.tunnel) {
    try {
      preview.tunnel.kill('SIGTERM');
    } catch {
      // already dead
    }
  }
  await new Promise((r) => setTimeout(r, 100));
  try {
    preview.devServer.kill('SIGTERM');
  } catch {
    // already dead
  }

  const sigkillTimer = setTimeout(() => {
    try {
      preview.devServer.kill('SIGKILL');
    } catch {
      // already dead
    }
    try {
      preview.tunnel?.kill('SIGKILL');
    } catch {
      // already dead
    }
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

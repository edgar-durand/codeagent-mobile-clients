import type { ChildProcess } from 'child_process';
import { forgetPreviewPort } from './port-registry';
import { restorePreviewHostAllow } from './host-allow';
import type { PreviewDetection } from '@codeam/shared';

export * from './build-heal';
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
export * from './port-registry';

/**
 * One running preview slot, keyed by sessionId. The plugin process is
 * the source of truth — when this map is empty for a session, the
 * preview is stopped. The Redis snapshot on the backend mirrors the
 * latest state but never the running child processes themselves.
 */
export interface ActivePreview {
  sessionId: string;
  /**
   * El dev server que ARRANCAMOS nosotros.
   *
   * ⚠️ `null` significa ADOPTADO: el puerto ya estaba servido por el dev
   * server del propio usuario (arrancado por el agente, o a mano en una
   * terminal) y lo estamos tunelando en vez de morir con «port already in
   * use». No es nuestro, así que **no se mata al parar el preview** — pararlo
   * mataría el servidor que el usuario tenía corriendo antes de abrir esto.
   */
  devServer: ChildProcess | null;
  /** Null when the framework manages its own tunnel (Expo / codespace). */
  tunnel: ChildProcess | null;
  url: string;
  framework: string;
  /** The detection this preview was started from, so a restart can
   *  re-spawn it without re-reading `.codeam/preview.json`. */
  detection: PreviewDetection;
  /** The project cwd this preview runs in — needed to restore the
   *  dev-server host-allow config edit (`host-allow.ts`) on teardown. */
  cwd: string;
  /** Stops the Next.js build-clobber watcher (`build-heal.ts`) attached to
   *  THIS preview instance, if any. Set by `maybeAttachBuildHeal`
   *  (`commands/start/handlers.ts`) right after a successful bring-up.
   *  `killPreview` calls it so a stopped/replaced preview never leaves a
   *  dangling fs.watch handle or a pending debounce timer running. */
  buildHealStop?: () => void;
  /**
   * El proxy del inspector, cuando se interpuso entre el túnel y el dev
   * server. `undefined` = camino directo (Expo, o el proxy no arrancó).
   *
   * Cerrarlo es parte del apagado: es un servidor HTTP nuestro escuchando en
   * localhost, y sus websockets de recarga en caliente mantienen vivo el
   * proceso si nadie los mata.
   */
  inspector?: { close(): Promise<void> } | null;
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
  // ⚠️ `!pid`, no `pid == null`. Con `pid === 0`, `-pid` es `0` y
  // `process.kill(0, …)` señaliza al GRUPO DE PROCESOS ACTUAL — o sea, el CLI
  // se mata a sí mismo y se lleva por delante al agente y al dev server. Hoy
  // no es alcanzable (`child.pid` es `undefined` en un spawn fallido, nunca
  // `0`), pero la distancia entre «no alcanzable» y «catastrófico» es un
  // carácter, y lo destapó un test al matar a su propio runner.
  if (!pid) return;
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

  // Close the build-heal fs.watch handle (if any) BEFORE anything else, so a
  // debounced restart it already scheduled can never fire against a preview
  // we're in the middle of tearing down.
  preview.buildHealStop?.();

  // Drop the persistent port-ownership record — a clean teardown means the
  // next start should probe the LIVE port, not trust a now-stale record.
  forgetPreviewPort(preview.detection.port);

  if (preview.tunnel) {
    killProcessTree(preview.tunnel, 'SIGTERM');
  }
  await new Promise((r) => setTimeout(r, 100));

  // ⚠️ El proxy va DESPUÉS del túnel y ANTES del dev server, en su sitio de la
  // cadena. Antes que el túnel, dejaría al túnel apuntando a un puerto muerto
  // y el usuario vería un 502 en el instante de parar; después del dev server,
  // el dev server intentaría escribir en sockets que ya nadie atiende.
  // Best-effort: un cierre que falle no puede impedir que se mate el proceso
  // que de verdad hay que matar.
  try {
    await preview.inspector?.close();
  } catch {
    /* nunca bloquear el apagado */
  }

  // Adoptado (`devServer === null`) = no es nuestro y no se toca. Parar el
  // preview cierra el túnel y el proxy; el dev server del usuario sigue como
  // estaba.
  if (preview.devServer) killProcessTree(preview.devServer, 'SIGTERM');

  const sigkillTimer = setTimeout(() => {
    if (preview.devServer) killProcessTree(preview.devServer, 'SIGKILL');
    if (preview.tunnel) killProcessTree(preview.tunnel, 'SIGKILL');
  }, 250);
  // Don't block process exit on this safety timer.
  sigkillTimer.unref?.();

  // Restore the user's dev-server config that we wrapped to trust the tunnel
  // domains (Next `allowedDevOrigins` / Vite `server.allowedHosts`). Best-effort
  // — a leftover also self-heals on the next preview bring-up.
  await restorePreviewHostAllow(preview.cwd);

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

export { canAdoptPort, verdictFor, probePort } from './adopt-port';
export type { AdoptVerdict } from './adopt-port';

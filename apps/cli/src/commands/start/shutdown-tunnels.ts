import { stopExportTunnel } from '../../scratch/export-tunnel';
import { killAllPreviews } from '../../services/preview/index';

/**
 * The awaited half of the start.ts shutdown: reaps every preview (dev server
 * + tunnel) AND the standalone scratch-export tunnel. Its cloudflared child
 * would otherwise outlive the CLI and stay registered on the box's named
 * tunnel, load-balancing the next session's connector. Best-effort: never
 * rejects, and a failed preview reap never skips the export tunnel.
 */
export async function reapPreviewsAndExportTunnel(): Promise<void> {
  try {
    await killAllPreviews();
  } catch {
    // best-effort — the SIGKILL safety timer inside killPreview
    // still fires regardless of any await rejection here.
  }
  try {
    await stopExportTunnel();
  } catch {
    // best-effort — process.exit follows regardless.
  }
}

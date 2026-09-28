import { withTimeout } from '../../agents/acp/withTimeout';
import { stopExportTunnel } from '../../scratch/export-tunnel';
import { killAllPreviews } from '../../services/preview/index';

/** Upper bound on the reap: a wedged child must never hang the process exit. */
export const REAP_TIMEOUT_MS = 5_000;

/**
 * The awaited half of every session shutdown (start.ts PTY path and each ACP
 * exit): reaps every preview (dev server + tunnel) AND the standalone
 * scratch-export tunnel. Its cloudflared child would otherwise outlive the
 * CLI and stay registered on the box's named tunnel, load-balancing the next
 * session's connector. Both run in parallel, so one failing or hanging never
 * skips the other. Best-effort and bounded: never rejects, and resolves after
 * `timeoutMs` at the latest.
 */
export async function reapPreviewsAndExportTunnel(timeoutMs = REAP_TIMEOUT_MS): Promise<void> {
  // A synchronous throw from either reaper must not skip the other.
  const settle = (fn: () => Promise<void>): Promise<void> =>
    Promise.resolve().then(fn).catch(() => undefined);
  await withTimeout(Promise.all([settle(killAllPreviews), settle(stopExportTunnel)]), timeoutMs);
}

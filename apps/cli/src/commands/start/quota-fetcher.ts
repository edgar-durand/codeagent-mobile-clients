import type { RuntimeStrategy } from '../../agents/strategy';
import type { HistoryService } from '../../services/history.service';

/**
 * Background `/usage` probe — spawns a separate, short-lived Claude
 * Code process under a Python PTY helper so we can ask it for the
 * weekly quota + reset window without disturbing the active turn.
 *
 * Why not use the in-flight Claude PTY: that one's owned by the
 * user's interactive session — feeding it `/usage` would drop the
 * slash command into whatever they were typing. Spawning a side
 * process that exits ~12 s later avoids that.
 *
 * macOS / Linux only. The helper uses `os.fork`, `pty.openpty`,
 * `fcntl.ioctl(TIOCSWINSZ)` — all Unix-only — and gracefully
 * no-ops on Windows where Python may not be on PATH or those
 * modules may import-fail.
 *
 * The subprocess spawn + parse logic is delegated through the
 * RuntimeStrategy so future agents can swap in their own quota
 * mechanism without touching this file.
 */

/** Set to `true` while a fetch is in flight; prevents reentry. */
let inProgress = false;

export function fetchQuotaUsage(runtime: RuntimeStrategy, historySvc: HistoryService): void {
  if (inProgress) return;
  inProgress = true;

  runtime.fetchWeeklyUsage()
    .then((result) => {
      if (!result) return;
      historySvc.setQuotaPercent(result.percent);
      if (result.resetAt) historySvc.setRateLimitReset(result.resetAt);
    })
    .finally(() => {
      inProgress = false;
    });
}

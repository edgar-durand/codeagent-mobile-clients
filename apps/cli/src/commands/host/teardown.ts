// src/commands/host/teardown.ts
//
// Best-effort de-provision actions for `self_hosted_wipe`: disable the
// systemd unit and tear down the per-host Headroom proxy + durable init.
// Moved VERBATIM out of host-agent.ts (Phase 3 refactor) — only the
// import/export wiring changed (exported so the supervisor imports them
// as its injectable defaults).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { killHeadroomProxy } from '../../services/headroom/proxy-pid';
import { headroomConfigPath, persistHeadroomConfig } from './headroom-config';

/**
 * Default best-effort service de-provision for `self_hosted_wipe`. The
 * agent runs as root via its systemd unit, so it can usually disable
 * itself; wrapped so a permission failure is non-fatal.
 */
export const defaultDisableService = (): void => {
  try {
    execFileSync('systemctl', ['disable', '--now', 'codeam-host-agent'], { stdio: 'ignore' });
  } catch {
    /* may not be permitted / not on systemd — best-effort */
  }
};

/**
 * Best-effort Headroom teardown for `self_hosted_wipe` (full de-provision).
 *
 * The Headroom proxy is a per-HOST singleton on :8787, started detached +
 * unref'd with NO handle retained (by the supervisor warm-start and/or the
 * durable `headroom install` + SessionStart hook). The supervisor's normal
 * child teardown therefore never reaps it, so on a full de-provision it would
 * leak: keep holding :8787, keep a uvicorn master+worker alive, and keep
 * polling Anthropic subscription usage every 5 min. We must stop it explicitly.
 *
 * IMPORTANT: this runs ONLY on `self_hosted_wipe` (the whole host is being
 * removed), never on `self_hosted_stop` — the proxy is shared across all
 * sessions on the box, so killing it per-session would break the others.
 */
export const defaultTeardownHeadroom = (): void => {
  // 1. Undo the durable integration first so a future agent start can't relaunch
  //    the proxy from the SessionStart hook / settings.json base URL.
  try {
    const kind = (JSON.parse(fs.readFileSync(headroomConfigPath(), 'utf8')) as { agent?: string })
      .agent;
    if (kind) {
      execFileSync('headroom', ['unwrap', kind], { stdio: 'ignore', timeout: 15_000 });
    }
  } catch {
    /* no config / headroom absent / unwrap unsupported — best-effort */
  }
  // 2. Stop the running proxy (no handle was kept). SIGTERM lets uvicorn flush
  //    its savings ledger and reap its own workers. Targeted pidfile kill,
  //    falling back to `pkill -TERM -f 'headroom.*proxy'` when no live
  //    recorded pid exists (proxy launched by an older CLI).
  killHeadroomProxy();
  // 3. Mark the persisted config disabled so any stray resume can't point a
  //    child at the now-dead proxy.
  persistHeadroomConfig({ enabled: false });
};

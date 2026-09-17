// src/commands/host/teardown.ts
//
// Best-effort de-provision action for `self_hosted_wipe`: disable the
// systemd unit.
// Moved VERBATIM out of host-agent.ts (Phase 3 refactor) — only the
// import/export wiring changed (exported so the supervisor imports them
// as its injectable defaults).
import { execFileSync } from 'node:child_process';

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

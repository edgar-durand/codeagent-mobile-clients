import { log } from '../services/logger';

let installed = false;

/**
 * Install process-level crash guards for the long-lived relay
 * (`codeam start` / `codeam pair-auto` / `codeam start-infra-only`).
 *
 * ## Why this exists (the relay-death root cause)
 *
 * The relay is a DAEMON: it must survive a stray async failure and keep
 * serving the paired session. Node's DEFAULT behaviour is the opposite —
 * since Node 15 an `unhandledRejection` PRINTS and EXITS the process, and an
 * `uncaughtException` with no listener also exits. The CLI had NO
 * process-level handler, so a SINGLE fire-and-forget promise that rejected
 * took the whole relay down:
 *
 *   - a backend POST that fails with `socket hang up` / HTTP 404 after a long
 *     ACP turn (the observed 2026-07 codespace incident),
 *   - a `void backgroundTask()` (provisioning, history flush, outbox flush)
 *     whose inner error isn't caught,
 *   - any `.then()` without a trailing `.catch()`.
 *
 * On a codespace there is no supervisor, so the relay stayed dead until the
 * next wake/redeploy — the session hung "forever". Worse, it died SILENTLY:
 * with no handler there was no log line, so the offending path was invisible.
 *
 * ## What these handlers do
 *
 * They convert that fatal default into a logged, survivable event: the full
 * error + STACK is written to the always-on debug log (`log.error` is mirrored
 * to `~/.codeam/debug-<pid>.log` regardless of `CODEAM_LOG`), and the process
 * KEEPS RUNNING. This is a SAFETY NET, not a licence to leave rejections
 * uncaught — every line this logs is a real bug to fix at its call site, and
 * now it leaves a stack to find it by.
 *
 * Idempotent: safe to call from every relay entrypoint (they nest — pair-auto
 * calls start / start-infra-only).
 */
export function installRelayCrashGuards(): void {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason) => {
    log.error('process', `unhandledRejection — relay kept alive — ${describeReason(reason)}`);
  });

  process.on('uncaughtException', (err) => {
    log.error('process', `uncaughtException — relay kept alive — ${describeReason(err)}`);
  });
}

/**
 * Render an error/rejection reason with its full stack when available. The
 * logger only persists `err.name`/`err.message` in its structured ctx, so we
 * fold the stack into the message string ourselves — it's the only breadcrumb
 * that pinpoints WHICH un-awaited promise leaked.
 */
function describeReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  }
  try {
    return typeof reason === 'string' ? reason : JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

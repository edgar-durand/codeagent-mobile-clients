import * as fs from 'node:fs';

import { log } from '../services/logger';

/**
 * Tiny "swallow-and-ignore" helpers for genuinely best-effort side effects.
 *
 * The CLI has ~40 comment-only `catch {}` blocks. Most are legitimately
 * best-effort (unlink a temp file, kill a child that may already be dead),
 * but the sheer volume camouflages the handful of catches that silently
 * swallow a genuinely-dangerous error. Routing the mechanical ones through
 * these helpers makes a bare `catch {}` in future review a red flag rather
 * than background noise.
 *
 * Every swallow is mirrored to the file log at `debug` level (a no-op for
 * normal users, full breadcrumb under `CODEAM_DEBUG=1`), so "best-effort"
 * never means "invisible".
 *
 * These are for side effects that DON'T recover from the error. A `catch`
 * that does real work (fallback, retry, conditional cleanup) must keep its
 * explicit block — do NOT funnel those through here.
 */

const TAG = 'quiet';

/** Anything with a `kill(signal?)` method — `ChildProcess`, our agent service, … */
interface Killable {
  kill(signal?: NodeJS.Signals | number): unknown;
}

/**
 * Run a synchronous best-effort side effect, swallowing (and debug-logging)
 * any thrown error. Use for one-off cleanup that has no meaningful recovery.
 */
export function quiet(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.debug(TAG, 'ignored sync error', err);
  }
}

/**
 * Await a best-effort promise (or a thunk returning one), swallowing (and
 * debug-logging) any rejection. Resolves once the work settles either way.
 */
export async function quietAsync<T>(work: Promise<T> | (() => Promise<T>)): Promise<void> {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (err) {
    log.debug(TAG, 'ignored async error', err);
  }
}

/**
 * Best-effort remove of a file path. Missing paths are a no-op (`force`);
 * any other error (EPERM, EBUSY, …) is swallowed and debug-logged.
 * Behaviour-identical to a `try { fs.unlinkSync(p) } catch {}`.
 */
export function rmIfExistsQuiet(path: string): void {
  try {
    fs.rmSync(path, { force: true });
  } catch (err) {
    log.debug(TAG, `rmIfExists failed for ${path}`, err);
  }
}

/**
 * Best-effort signal to a child process or pid. `undefined`/`null` targets
 * are a no-op; a dead process (ESRCH / already exited) is swallowed and
 * debug-logged. Defaults to `SIGTERM`.
 */
export function killQuiet(
  target: Killable | number | undefined | null,
  signal: NodeJS.Signals | number = 'SIGTERM',
): void {
  if (target === undefined || target === null) return;
  try {
    if (typeof target === 'number') {
      process.kill(target, signal);
    } else {
      target.kill(signal);
    }
  } catch (err) {
    log.debug(TAG, 'kill failed', err);
  }
}

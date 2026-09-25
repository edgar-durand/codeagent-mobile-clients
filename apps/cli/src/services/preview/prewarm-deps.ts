import { log } from '../logger';
import { runSetupCommand } from './run-setup';
import { detectMissingNodeDeps } from './setup-deps';

/**
 * Install the project's Node dependencies in the BACKGROUND as soon as the
 * session is up, so tapping Preview later skips the slowest step (1.5 min on a
 * mid-size monorepo, measured on a CodeAgent Box 2026-09-25). Owner request:
 * the user shouldn't wait on Preview when they finally need it.
 *
 * Only the install — never the dev server or a tunnel: a warm server would
 * hold memory and the box's CPU for the whole session whether or not Preview
 * is ever used, and a tunnel would publish the app without the user asking.
 *
 * ⚠️ The install is shared state. `node_modules/` exists as soon as npm starts
 * writing, and the Preview start trusts an existing `node_modules/` — so a tap
 * mid-install would boot the dev server on a half-installed tree. The start
 * pipeline MUST `await awaitPrewarmInstall()` before its own pre-flight.
 */
let inFlight: Promise<void> | null = null;

const PREWARM_INSTALL_TIMEOUT_MS = 5 * 60_000;

export function prewarmNodeDeps(cwd: string): Promise<void> {
  if (inFlight) return inFlight;
  const missing = detectMissingNodeDeps(cwd);
  // yarn may not be installed yet; the start pipeline owns that recovery.
  if (!missing || missing.cmd !== 'npm') return Promise.resolve();
  log.info('preview', `prewarm: installing deps (${missing.cmd} ${missing.args.join(' ')})`);
  const started = Date.now();
  inFlight = runSetupCommand(missing.cmd, missing.args, cwd, undefined, {
    timeoutMs: PREWARM_INSTALL_TIMEOUT_MS,
  })
    .then((r) => {
      log.info('preview', `prewarm: deps ${r.status} after ${Date.now() - started}ms`);
    })
    .catch((err: unknown) => {
      log.info('preview', `prewarm: deps install threw (${String(err)})`);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Resolves once any background install has finished (immediately if none). */
export function awaitPrewarmInstall(): Promise<void> {
  return inFlight ?? Promise.resolve();
}

export function _resetPrewarmDepsForTests(): void {
  inFlight = null;
}

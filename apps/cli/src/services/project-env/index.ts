/**
 * Reusable per-repo `.env` — the CLI half of the "keep the `.env` for a new
 * session of the same repo, like node_modules" feature.
 *
 * Two directions, both keyed by the stable git-origin `projectKey` (the SAME
 * identity Beads uses, `beads/project-key.ts`), so the same repo resolves to the
 * same vault row on a laptop, a codespace, and a fresh box:
 *
 *  - `syncProjectEnvUp(cwd, ctx)` — read `<cwd>/.env` and PUSH it to the backend
 *    vault. Called after the user edits the env from the app (`env_write`) so
 *    the latest `.env` is always captured.
 *  - `restoreProjectEnvIfMissing(cwd, ctx)` — during bring-up, if `<cwd>/.env`
 *    does NOT already exist, PULL the stored one and write it. Mirrors
 *    `ensureEnvFile`'s "never overwrite an existing `.env`" rule — the working
 *    copy always wins.
 *
 * Everything here is best-effort + non-fatal: the backend vault is a convenience
 * layer, never a hard dependency of a session or a preview. A missing token,
 * offline backend, or absent `.env` is a silent no-op.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { deriveProjectIdentity } from '../../beads/project-key';
import { parseDotenv } from '../preview/dotenv';
import { pullProjectEnv, pushProjectEnv } from '../pairing.service';
import { log } from '../logger';

/** The subset of the command-handler context this feature needs. */
export interface ProjectEnvCtx {
  sessionId: string;
  pluginId: string;
  pluginAuthToken?: string;
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Push `<cwd>/.env` to the backend vault for later reuse. No-op when there's no
 * token (an older/unauthed session), no `.env`, or the push fails.
 */
export async function syncProjectEnvUp(cwd: string, ctx: ProjectEnvCtx): Promise<void> {
  if (!ctx.pluginAuthToken) return;
  const content = await readIfExists(path.join(cwd, '.env'));
  if (content == null) return; // nothing to store
  try {
    const { projectKey, projectLabel } = deriveProjectIdentity(cwd);
    const keyCount = parseDotenv(content).length;
    const res = await pushProjectEnv({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken: ctx.pluginAuthToken,
      projectKey,
      projectLabel,
      content,
      keyCount,
    });
    if (res.ok) log.info('project-env', `pushed .env (${keyCount} vars) for ${projectLabel}`);
    else log.debug('project-env', `push .env failed (${res.status}) — non-fatal`);
  } catch (err) {
    log.debug('project-env', `push .env skipped: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * If `<cwd>/.env` does NOT exist, pull the stored one from the vault and write
 * it. Returns true when a `.env` was restored, false otherwise. Never
 * overwrites an existing `.env` (the working copy always wins) and never throws.
 */
export async function restoreProjectEnvIfMissing(
  cwd: string,
  ctx: ProjectEnvCtx,
): Promise<boolean> {
  if (!ctx.pluginAuthToken) return false;
  const envPath = path.join(cwd, '.env');
  if ((await readIfExists(envPath)) != null) return false; // never clobber
  try {
    const { projectKey, projectLabel } = deriveProjectIdentity(cwd);
    const stored = await pullProjectEnv({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken: ctx.pluginAuthToken,
      projectKey,
    });
    if (!stored) return false;
    // Write atomically so a crash mid-write can't leave a truncated `.env`.
    const tmp = path.join(cwd, '.env.codeam-restore.tmp');
    await fs.writeFile(tmp, stored.content, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, envPath);
    log.info('project-env', `restored .env (${stored.keyCount} vars) for ${projectLabel}`);
    return true;
  } catch (err) {
    log.debug('project-env', `restore .env skipped: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

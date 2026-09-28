import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RemoteCommand, CommandRelayService } from '../services/command-relay.service';
import { listExportFiles, topPaths } from './export-files';
import { buildZip } from './zip';
import { registerExport, exportDir, EXPORT_PATH_PREFIX } from './export-registry';
import { ensureExportBaseUrl } from './export-tunnel';
import { postZipDownloaded, type ScratchCtx } from './api';
import { saveToGithub } from './save-github';
import { isScratchWorkspace } from './workspace';
import { log } from '../services/logger';

/**
 * The subset of a command context these two agent-agnostic scratch handlers
 * need. Structurally compatible with `AcpCommandContext` (`{cmd, relay, opts,
 * ...}`) — narrower on purpose so the PTY `handlers` map (`commands/start/
 * handlers.ts`) can build a thin literal adapter from its own
 * `HandlerContext` instead of fabricating the full ACP machinery.
 */
export interface ScratchHandlerCtx {
  cmd: RemoteCommand;
  relay: CommandRelayService;
  opts: ScratchCtx;
}

/**
 * `scratch_export_zip` — "Download ZIP". OWNER RULING: this is available on
 * EVERY session, not only scratch ones — do NOT gate it on
 * `isScratchWorkspace`. Any cwd that isn't a git repo answers a user-safe
 * failure instead (both scratch projects and every real session are git
 * repos, so this only fires on a genuinely unsupported cwd).
 *
 * Builds the export file list; over the plan's `limitBytes` (`null` = PRO,
 * never reports `tooLarge`) answers the biggest top-level paths instead of
 * zipping. Otherwise zips, registers a one-shot download behind the box's
 * export tunnel, and answers the download URL. `postZipDownloaded` fires and
 * the tunnel hold is released on a completed download; the hold is ALSO
 * released if the token expires unclaimed, so it can never leak.
 */
export async function scratchExportZipH(ctx: ScratchHandlerCtx): Promise<void> {
  const { cmd, relay, opts } = ctx;
  const limit = (cmd.payload as { limitBytes?: number | null }).limitBytes ?? null;
  const cwd = process.cwd();

  // Filled once the download is actually ready. Kept OUTSIDE every
  // try/catch below so the final ack (after the block) can never be
  // re-caught and mistaken for a build/tunnel failure — a rejected ack
  // only means telling the caller failed, not that the download wasn't
  // prepared, so it must never trigger a second, misleading `failed` ack.
  let ready: { url: string; sizeBytes: number; expiresAt: string } | null = null;
  try {
    const list = await listExportFiles(cwd);
    if (limit !== null && list.totalBytes > limit) {
      await relay.sendResult(cmd.id, 'completed', {
        tooLarge: true,
        sizeBytes: list.totalBytes,
        limitBytes: limit,
        topPaths: topPaths(list.files),
      });
      return;
    }
    fs.mkdirSync(exportDir(), { recursive: true, mode: 0o700 });
    const file = path.join(exportDir(), `${randomBytes(8).toString('hex')}.zip`);
    const size = await buildZip(cwd, list, file);
    const scratchCtx: ScratchCtx = {
      sessionId: opts.sessionId,
      pluginId: opts.pluginId,
      pluginAuthToken: opts.pluginAuthToken,
    };
    // This inner try covers ONLY `ensureExportBaseUrl` — the one call that
    // actually means "the tunnel isn't available". Nothing else is nested
    // in here, so its `catch` can't misfire on an unrelated failure.
    let base: { baseUrl: string; release: () => void };
    try {
      base = await ensureExportBaseUrl(scratchCtx);
    } catch {
      fs.rmSync(file, { force: true });
      await relay.sendResult(cmd.id, 'failed', {
        error: "Couldn't prepare the download — try again.",
      });
      return;
    }
    // Registered only once the tunnel is up, so a tunnel failure never
    // leaves a dangling token behind.
    const { token, expiresAt } = registerExport(
      file,
      size,
      () => {
        void postZipDownloaded(scratchCtx);
        base.release();
      },
      () => base.release(),
    );
    ready = {
      url: `${base.baseUrl}${EXPORT_PATH_PREFIX}${token}`,
      sizeBytes: size,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (err) {
    const message = (err as Error).message ?? '';
    if (/not a git repository/i.test(message)) {
      await relay.sendResult(cmd.id, 'failed', {
        error: "This session's folder isn't a git project, so it can't be exported.",
      });
      return;
    }
    // The raw message can carry git argv and box paths: log it, never ack it.
    log.warn('scratch', `export ZIP build failed: ${message}`);
    await relay.sendResult(cmd.id, 'failed', { error: "Couldn't build the ZIP — try again." });
    return;
  }

  await relay.sendResult(cmd.id, 'completed', ready);
}

/**
 * `scratch_save_github` — creates the repo, commits pending changes, and
 * pushes (`saveToGithub`). Refused outright outside a scratch project: a
 * cloned repo already has its own remote and must never be re-pointed.
 */
export async function scratchSaveGithubH(ctx: ScratchHandlerCtx): Promise<void> {
  const { cmd, relay } = ctx;
  if (!isScratchWorkspace(process.cwd())) {
    await relay.sendResult(cmd.id, 'failed', {
      code: 'SAVE_FAILED',
      error: 'Save to GitHub is only available for projects started from scratch.',
    });
    return;
  }
  const p = cmd.payload as { repoName?: string; private?: boolean; token?: string };
  if (!p.repoName || !p.token) {
    await relay.sendResult(cmd.id, 'failed', {
      code: 'SAVE_FAILED',
      error: 'Missing repo name or token.',
    });
    return;
  }
  try {
    const out = await saveToGithub(process.cwd(), {
      repoName: p.repoName,
      private: p.private !== false,
      token: p.token,
    });
    await relay.sendResult(cmd.id, 'completed', out);
  } catch (err) {
    const code = (err as { code?: string }).code === 'REPO_NAME_TAKEN' ? 'REPO_NAME_TAKEN' : 'SAVE_FAILED';
    await relay.sendResult(cmd.id, 'failed', { code, error: (err as Error).message });
  }
}

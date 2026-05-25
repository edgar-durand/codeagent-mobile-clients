import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import { exec } from 'node:child_process';
import {
  PROTOCOL_VERSION,
  type FileChangedEvent,
  type FileChangeStatus,
  type PendingReviewHunkEvent,
} from '@codeagent/shared';
import { parseUnifiedDiff } from './file-watcher/diff-parser';
import { AgentStrategyRegistry } from './strategies/AgentStrategyRegistry';

// TODO: tests — the VS Code plugin currently only covers
// `terminal-agent.test.ts`. The shape of this service (diff parsing +
// debounce + retry transport) maps closely to the CLI's
// `file-watcher.service.test.ts`; port that suite in a follow-up.

/**
 * Watches every open VS Code workspace folder for file changes during a
 * paired session and emits two backend events per change:
 *
 *   1. `POST /api/files/changed` (one per file, debounced)
 *      → upserts into the mobile Files screen.
 *   2. `POST /api/review/hunks` (one per hunk in the diff)
 *      → fills the Pending Review Queue. Aggressive policy — every
 *      hunk in the diff goes to the queue and the mobile user
 *      approves/rejects each one independently.
 *
 * Mirrors `apps/cli/src/services/file-watcher.service.ts`. Differences:
 *
 *   - Uses `vscode.workspace.onDidSaveTextDocument` /
 *     `onDidCreateFiles` / `onDidDeleteFiles` instead of chokidar.
 *     This is more accurate inside VS Code because agent edits land at
 *     save-time, not on raw filesystem flushes; we also avoid bundling
 *     chokidar into the .vsix (smaller VSIX, no native fsevents).
 *   - Computes diffs via `child_process.exec('git diff ...')` because
 *     we don't have an existing helper at this level — the CLI's
 *     equivalent spawns through its own pipeline.
 *   - Multi-root workspaces: one logical watcher per `WorkspaceFolder`,
 *     all multiplexed through a single set of VS Code event
 *     subscriptions. The folder is resolved per event via
 *     `vscode.workspace.getWorkspaceFolder(uri)`.
 *   - Agent-activity gate: only emits when an `AgentStrategy` ran
 *     within `AGENT_ACTIVITY_WINDOW_MS`. Without that gate every
 *     manual save during normal coding would flood the backend with
 *     "file changed" events.
 *
 * Network failures are fire-and-forget (logged warning on retry
 * exhaustion). We never block UI work on emission.
 */

/** Debounce window per file. Rapid sequential saves coalesce. */
const DEBOUNCE_MS = 250;

/** Max retries on transient network failure. */
const MAX_RETRIES = 2;

/** Linear backoff between retries (300 / 600 ms). */
const RETRY_BACKOFF_MS = 300;

/**
 * Only emit events when an agent strategy was active in the last
 * minute. Tuned to be wide enough to catch a multi-edit agent burst
 * (Claude often takes 30–60 s between turns) but narrow enough that
 * a user editing in peace doesn't ship every save.
 */
const AGENT_ACTIVITY_WINDOW_MS = 60_000;

/** Best-effort buffer cap on `git diff` stdout (8 MB). */
const GIT_DIFF_MAX_BUFFER = 8 * 1024 * 1024;

/** Hard timeout on a single `git diff` invocation. */
const GIT_DIFF_TIMEOUT_MS = 5_000;

/** Files whose paths match any of these segments are silently dropped. */
const IGNORED_PATH_PARTS: ReadonlyArray<string> = [
  'node_modules',
  '.git',
  '.next',
  '.expo',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'dist',
  'build',
  'out',
  'coverage',
  '__pycache__',
];

type ChangeType = 'add' | 'change' | 'unlink';

interface PendingFile {
  timer: NodeJS.Timeout;
  changeType: ChangeType;
}

export interface FileWatcherServiceOptions {
  /** Paired-session id, used as the upsert key on the backend. */
  sessionId: string;
  /** Per-pairing pluginId — required by the backend PluginAuthGuard. */
  pluginId: string;
  /** Per-pairing secret — replayed as `X-Plugin-Auth-Token`. */
  pluginAuthToken: string;
  /** API base URL — already resolved from `SettingsService.apiBaseUrl`. */
  apiBaseUrl: string;
  /** Output channel shared with the rest of the plugin. */
  log: vscode.OutputChannel;
}

/**
 * Hooks into VS Code's editor events, runs `git diff` per-folder for
 * each change, and POSTs the results to the backend. One instance per
 * paired session. Owned by `ControllerPanelProvider`.
 */
/**
 * Walk up from `startDir` until we find a directory that contains
 * a `.git` entry (regular .git dir, or a `gitdir: …` file for
 * worktrees / submodules). Returns the discovered repo root or
 * `null` when we reach the filesystem root with no match.
 *
 * Mirrors the CLI's `findGitRoot` so a workspace folder that
 * contains several sub-repos (e.g. an umbrella project opened as
 * one folder) attributes each file to its enclosing repo instead
 * of running `git diff` from the umbrella that is itself non-git.
 */
export function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const seen = new Set<string>();
  for (let i = 0; i < 256; i++) {
    if (seen.has(dir)) return null;
    seen.add(dir);
    try {
      const gitPath = path.join(dir, '.git');
      const stat = fs.statSync(gitPath, { throwIfNoEntry: false });
      if (stat && (stat.isDirectory() || stat.isFile())) return dir;
    } catch {
      // EACCES / EPERM — keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export class FileWatcherService {
  private readonly disposables: vscode.Disposable[] = [];
  /** Keyed by absolute file path so multi-root workspaces don't collide. */
  private readonly pending = new Map<string, PendingFile>();
  /** Lazy cache of (file directory → git root) to avoid re-statting
   *  parents on every save in a busy editor session. */
  private readonly gitRootByDir = new Map<string, string | null>();
  private started = false;
  private stopped = false;

  constructor(private readonly opts: FileWatcherServiceOptions) {}

  /**
   * Subscribe to save/create/delete events for every workspace folder.
   * Idempotent — second call is a no-op. After `stop()` the instance
   * is dead; create a new one for the next pairing.
   */
  start(): void {
    if (this.started) return;
    if (this.stopped) {
      throw new Error('FileWatcherService already stopped — re-instantiate to restart.');
    }
    this.started = true;

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.opts.log.appendLine(
        '[fileWatcher] no workspace folders open — events will be ignored until one is added',
      );
    } else {
      this.opts.log.appendLine(
        `[fileWatcher] watching ${folders.length} folder(s) for session=${this.opts.sessionId.slice(0, 8)}`,
      );
    }

    // VS Code multiplexes events across all open folders. We bind once
    // and resolve the owning folder per event via getWorkspaceFolder.
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        // Untitled / git: / output: schemes shouldn't reach the backend.
        if (doc.uri.scheme !== 'file') return;
        this.schedule(doc.uri.fsPath, 'change');
      }),
      vscode.workspace.onDidCreateFiles((evt) => {
        for (const uri of evt.files) {
          if (uri.scheme !== 'file') continue;
          this.schedule(uri.fsPath, 'add');
        }
      }),
      vscode.workspace.onDidDeleteFiles((evt) => {
        for (const uri of evt.files) {
          if (uri.scheme !== 'file') continue;
          this.schedule(uri.fsPath, 'unlink');
        }
      }),
    );
  }

  /**
   * Tear down all subscriptions and clear pending debounce timers.
   * Idempotent.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();

    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch (err) {
        this.opts.log.appendLine(`[fileWatcher] disposable threw: ${formatError(err)}`);
      }
    }
    this.disposables.length = 0;
    this.opts.log.appendLine(
      `[fileWatcher] stopped (session=${this.opts.sessionId.slice(0, 8)})`,
    );
  }

  /** Visible for tests. */
  /* @internal */ _scheduleForTest(absPath: string, changeType: ChangeType): void {
    this.schedule(absPath, changeType);
  }

  private schedule(absPath: string, changeType: ChangeType): void {
    if (this.stopped) return;
    if (isIgnoredPath(absPath)) return;

    // Agent-activity gate: drop the event if no agent strategy ran
    // in the last AGENT_ACTIVITY_WINDOW_MS. Saves the user a flood of
    // "file changed" events while they edit alone.
    if (!this.isAgentRecentlyActive()) return;

    const folder = this.resolveFolder(absPath);
    if (!folder) {
      // File not under any open workspace folder — VS Code can deliver
      // such events when files outside the workspace are touched via
      // the API. Skip; the backend keys on relPath and we have none.
      return;
    }

    const existing = this.pending.get(absPath);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.pending.delete(absPath);
      void this.emitForFile(absPath, changeType, folder.uri.fsPath).catch((err) => {
        this.opts.log.appendLine(`[fileWatcher] emitForFile threw: ${formatError(err)}`);
      });
    }, DEBOUNCE_MS);

    this.pending.set(absPath, { timer, changeType });
  }

  private resolveFolder(absPath: string): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absPath));
  }

  private isAgentRecentlyActive(): boolean {
    const ts = AgentStrategyRegistry.getInstance(this.opts.log).lastAgentActivityTs;
    if (ts <= 0) return false;
    return Date.now() - ts <= AGENT_ACTIVITY_WINDOW_MS;
  }

  private async emitForFile(
    absPath: string,
    changeType: ChangeType,
    folderRoot: string,
  ): Promise<void> {
    if (this.stopped) return;

    // Resolve the file's enclosing git repo. For workspace folders
    // that are themselves git repos this collapses to the folder
    // root; for umbrella workspace folders containing several
    // sub-repos (common in monorepos / dotfile-style layouts) we
    // get the actual git root per file instead of running `git diff`
    // from a non-git parent.
    const fileDir = path.dirname(absPath);
    let gitRoot = this.gitRootByDir.get(fileDir);
    if (gitRoot === undefined) {
      gitRoot = findGitRoot(fileDir);
      this.gitRootByDir.set(fileDir, gitRoot);
    }
    if (!gitRoot) {
      // File isn't inside any git repo — drop silently. The backend
      // rejects zero-stat rows anyway and surfacing a no-diff path
      // pollutes the rail.
      this.opts.log.appendLine(
        `[fileWatcher] no enclosing git repo for ${absPath} — suppressing emit`,
      );
      return;
    }

    const relPath = path.relative(gitRoot, absPath);
    if (!relPath || relPath.startsWith('..')) return;

    // `repoPath` is the git root relative to the workspace folder so
    // the UI can render a repo chip per row. Empty string means
    // "this workspace folder IS the repo root".
    const repoPath = path.relative(folderRoot, gitRoot);
    const repoName = path.basename(gitRoot);

    if (changeType === 'unlink') {
      const diff = await this.gitDiff(gitRoot, relPath);
      if (diff !== null && diff.trim().length > 0) {
        const parsed = parseUnifiedDiff(diff);
        const finalStatus: FileChangeStatus = 'deleted';
        await this.postFileChanged({
          sessionId: this.opts.sessionId,
          pluginId: this.opts.pluginId,
          filePath: relPath,
          fileStatus: finalStatus,
          linesAdded: parsed.totalLinesAdded,
          linesRemoved: parsed.totalLinesRemoved,
          hunkCount: parsed.hunks.length,
          reviewStatus: parsed.hunks.length > 0 ? 'awaiting_review' : undefined,
          repoPath,
          repoName,
        });
        for (const hunk of parsed.hunks) {
          await this.postReviewHunk({
            sessionId: this.opts.sessionId,
            pluginId: this.opts.pluginId,
            filePath: relPath,
            fileStatus: finalStatus,
            hunkHeader: hunk.header,
            lines: hunk.lines,
            linesAdded: hunk.linesAdded,
            linesRemoved: hunk.linesRemoved,
          });
        }
        return;
      }
      // Untracked-and-removed: emit a zero-stat deletion so the rail
      // can drop the row.
      await this.postFileChanged({
        sessionId: this.opts.sessionId,
        pluginId: this.opts.pluginId,
        filePath: relPath,
        fileStatus: 'deleted',
        linesAdded: 0,
        linesRemoved: 0,
        hunkCount: 0,
        repoPath,
        repoName,
      });
      return;
    }

    const diff = await this.gitDiff(gitRoot, relPath);
    if (diff === null) {
      this.opts.log.appendLine(
        `[fileWatcher] git diff failed for ${relPath} in ${gitRoot} — suppressing emit`,
      );
      return;
    }

    const parsed = parseUnifiedDiff(diff);
    // Suppress no-op touches so file-system syncs (`git pull` of an
    // already-committed file, format-on-save with no diff) don't
    // pollute the rail with zero-stat rows.
    if (
      parsed.totalLinesAdded === 0 &&
      parsed.totalLinesRemoved === 0 &&
      parsed.hunks.length === 0
    ) {
      return;
    }

    const finalStatus: FileChangeStatus =
      parsed.fileStatus !== 'modified'
        ? parsed.fileStatus
        : changeType === 'add'
          ? 'added'
          : 'modified';

    const reviewStatus = parsed.hunks.length > 0 ? 'awaiting_review' : undefined;

    await this.postFileChanged({
      sessionId: this.opts.sessionId,
      pluginId: this.opts.pluginId,
      filePath: relPath,
      fileStatus: finalStatus,
      linesAdded: parsed.totalLinesAdded,
      linesRemoved: parsed.totalLinesRemoved,
      hunkCount: parsed.hunks.length,
      reviewStatus,
      repoPath,
      repoName,
    });

    for (const hunk of parsed.hunks) {
      await this.postReviewHunk({
        sessionId: this.opts.sessionId,
        pluginId: this.opts.pluginId,
        filePath: relPath,
        fileStatus: finalStatus,
        hunkHeader: hunk.header,
        lines: hunk.lines,
        linesAdded: hunk.linesAdded,
        linesRemoved: hunk.linesRemoved,
      });
    }
  }

  /**
   * Run `git diff --no-color -- <relPath>` in the given folder. Falls
   * back to `git diff --no-index -- /dev/null <relPath>` when the file
   * is untracked (the first call returns empty in that case). Returns
   * `null` when git isn't available / the folder isn't a repo.
   */
  private async gitDiff(folderRoot: string, relPath: string): Promise<string | null> {
    const tracked = await runGitDiff(folderRoot, ['diff', '--no-color', '--', relPath]);
    if (tracked === null) return null;
    if (tracked.trim().length > 0) return tracked;

    const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const untracked = await runGitDiff(folderRoot, [
      'diff',
      '--no-color',
      '--no-index',
      '--',
      devNull,
      relPath,
    ], { allowNonZeroExit: true });
    return untracked ?? '';
  }

  private async postFileChanged(body: FileChangedEvent): Promise<void> {
    await this.postWithRetries(`${this.opts.apiBaseUrl}/api/files/changed`, body);
  }

  private async postReviewHunk(body: PendingReviewHunkEvent): Promise<void> {
    await this.postWithRetries(`${this.opts.apiBaseUrl}/api/review/hunks`, body);
  }

  private async postWithRetries(
    url: string,
    body: FileChangedEvent | PendingReviewHunkEvent,
  ): Promise<void> {
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Codeam-Protocol-Version': PROTOCOL_VERSION,
      'X-Plugin-Auth-Token': this.opts.pluginAuthToken,
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const { statusCode, body: resBody } = await _transport.post(url, headers, payload);
        if (statusCode >= 200 && statusCode < 300) return;
        if (statusCode === 410 || statusCode === 404) {
          this.opts.log.appendLine(
            `[fileWatcher] session dead (status=${statusCode}) — dropping ${body.filePath}`,
          );
          // Stop emitting for the rest of this run, but keep the
          // subscriptions alive — the panel owns lifecycle.
          this.stopped = true;
          return;
        }
        this.opts.log.appendLine(
          `[fileWatcher] post failed url=${url} status=${statusCode} attempt=${attempt + 1} body=${resBody.slice(0, 200)}`,
        );
      } catch (err) {
        this.opts.log.appendLine(
          `[fileWatcher] post error url=${url} attempt=${attempt + 1} err=${formatError(err)}`,
        );
      }
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
      }
    }
    this.opts.log.appendLine(
      `[fileWatcher] giving up after ${MAX_RETRIES + 1} attempts — path=${body.filePath}`,
    );
  }
}

function isIgnoredPath(absPath: string): boolean {
  const sep = path.sep;
  // Walk path segments. `path.sep`-bracketed match works on both
  // POSIX and Windows.
  for (const part of IGNORED_PATH_PARTS) {
    if (absPath.includes(`${sep}${part}${sep}`)) return true;
    if (absPath.endsWith(`${sep}${part}`)) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Exec-based wrapper around `git diff`. Returns the captured stdout
 * (which may be empty) on success. Returns `null` when git is
 * unavailable or the folder isn't a repo. When `allowNonZeroExit` is
 * set we still resolve with stdout because `git diff --no-index`
 * exits 1 when files differ (which is exactly our case).
 *
 * Exposed via the `_gitDiffSeam` test seam so vitest can stub the
 * subprocess without spawning a real git.
 */
function runGitDiff(
  cwd: string,
  args: string[],
  opts: { allowNonZeroExit?: boolean } = {},
): Promise<string | null> {
  return _gitDiffSeam.run(cwd, args, opts);
}

export const _gitDiffSeam = {
  run: _runGitDiffImpl,
};

function _runGitDiffImpl(
  cwd: string,
  args: string[],
  opts: { allowNonZeroExit?: boolean } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    // We use `exec` here (single git invocation, captured stdout)
    // rather than `spawn` because the diff output is small and exec's
    // buffer accounting + timeout knobs are exactly what we want. The
    // CLI uses `spawn` because it streams chunks through a long-lived
    // PTY pipeline — we don't.
    const cmd = ['git', ...args.map(quoteArg)].join(' ');
    exec(
      cmd,
      {
        cwd,
        env: process.env,
        maxBuffer: GIT_DIFF_MAX_BUFFER,
        timeout: GIT_DIFF_TIMEOUT_MS,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) {
          const exitCode = typeof err.code === 'number' ? err.code : -1;
          if (opts.allowNonZeroExit && exitCode > 0) {
            // `git diff --no-index` returns 1 when files differ — that
            // is success for our purposes.
            resolve(stdout);
            return;
          }
          // ENOENT (git not installed) → exec sets err.code = 'ENOENT'.
          // Repo-not-a-repo errors print to stderr and exit non-zero.
          // Both translate to "no diff available" from our caller's POV.
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Conservative quoting for `exec` args. We control the args list (no
 * user-controlled command names; the paths come from VS Code), but
 * paths may contain spaces or shell metacharacters on Windows /
 * macOS, so single-quote on POSIX and double-quote on Windows.
 */
function quoteArg(arg: string): string {
  if (process.platform === 'win32') {
    if (/^[A-Za-z0-9_\-./:\\]+$/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  if (/^[A-Za-z0-9_\-./:]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Hand-rolled HTTP POST with the same shape as the CLI's transport.ts. */
interface PostResult {
  statusCode: number;
  body: string;
}

export const _transport = {
  post: _postImpl,
};

function _postImpl(
  url: string,
  headers: Record<string, string>,
  payload: string,
): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => {
          body += c.toString();
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
    });
    req.write(payload);
    req.end();
  });
}

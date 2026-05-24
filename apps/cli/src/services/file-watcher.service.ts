import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { resolveApiBaseUrl } from '@codeagent/shared';
import type {
  FileChangedEvent,
  PendingReviewHunkEvent,
  FileChangeStatus,
} from '@codeagent/shared';
import { log } from './logger';
import { parseUnifiedDiff } from './file-watcher/diff-parser';
import { _transport } from './file-watcher/transport';

/**
 * Watches the working directory for file changes during a paired
 * session and emits two backend events per change:
 *
 *   1. `POST /api/files/changed` (one per file, debounced 250 ms)
 *      → upserts into the mobile Files screen.
 *   2. `POST /api/review/hunks`  (one per hunk in the diff)
 *      → fills the Pending Review Queue. "Aggressive" policy — every
 *      hunk goes to the queue; the mobile user approves/rejects each
 *      one independently.
 *
 * Detection strategy v1 = chokidar filesystem watcher. Catches every
 * change under the working tree, agent-driven OR human-driven —
 * acceptable today because the backend keys on `(sessionId, filePath)`
 * and the mobile UI is happy to show "session timeline" entries that
 * include human edits while a session is open. A future v2 should
 * narrow this to agent-only emissions by parsing the PTY tool-use
 * blocks (Claude Code's TUI is well-formatted; Codex requires a
 * separate parser) — see the design notes in
 * `apps/cli/CLAUDE.md` (the producer section, when added).
 *
 * Diff source = `git diff --no-color -- <path>` for tracked files,
 * `git diff --no-color --no-index /dev/null <path>` for untracked
 * (gives us a clean "added" diff against an empty baseline). If the
 * working directory is not a git repo we fall back to a 1-hunk "added"
 * synthesizer that just emits each line of the file as an add (so
 * the Files screen at least shows the path + line counts).
 *
 * Network failures are fire-and-forget — a logged `warn` on retry
 * exhaustion, then the watcher keeps going. We do NOT block agent
 * output on file-change emission; the agent must always feel snappy.
 */

const API_BASE = resolveApiBaseUrl();

/** Debounce window per file. Rapid sequential writes coalesce. */
const DEBOUNCE_MS = 250;

/** Max retries on transient network failure (per emission). */
const MAX_RETRIES = 2;

/** Backoff between retries (linear: 300 / 600 ms). */
const RETRY_BACKOFF_MS = 300;

export interface FileWatcherOptions {
  /** Working directory to watch — typically `process.cwd()` at start time. */
  workingDir: string;
  /** Paired-session id, used as the upsert key on the backend. */
  sessionId: string;
  /** Per-pairing pluginId — required by PluginAuthGuard. */
  pluginId: string;
  /** Per-pairing secret — `X-Plugin-Auth-Token` value. Required. */
  pluginAuthToken: string;
  /** Override the API base URL (defaults to env / prod). Used by tests. */
  apiBaseUrl?: string;
}

interface PendingFile {
  /** Last write timestamp from chokidar. Used to compute idle. */
  lastEventAt: number;
  /** Pending timer; cleared if a fresh write arrives within DEBOUNCE_MS. */
  timer: NodeJS.Timeout;
  /** The change type as reported by chokidar — informational only;
   *  the authoritative `fileStatus` comes from the parsed git diff
   *  preamble inside `emitForFile`. */
  changeType: 'add' | 'change' | 'unlink';
}

/**
 * Minimal subset of chokidar's `FSWatcher` we actually use. Declared
 * inline so we don't expose the third-party type at our public API
 * and so the `chokidar` import stays inside `start()` — a dynamic
 * require keeps tests cheap (they can stub the watcher without
 * loading chokidar's native fsevents path).
 */
interface FileWatcher {
  on(event: 'add' | 'change' | 'unlink', handler: (filePath: string) => void): this;
  on(event: 'error', handler: (err: unknown) => void): this;
  close(): Promise<void>;
}

interface ChokidarLike {
  watch(paths: string, opts: Record<string, unknown>): FileWatcher;
}

/**
 * Windows-only: directories the legacy WinXP-compat junction layer
 * created inside every user profile. They are reparse points with a
 * DENY ACL for the user — `fs.watch` throws EPERM on descent. The
 * regex matches a path segment (between separators or at the end of
 * the path), so a real project directory called e.g. `recent-stuff`
 * won't be filtered.
 */
const WINDOWS_LEGACY_JUNCTIONS: RegExp[] = [
  /[\\/]Application Data([\\/]|$)/i,
  /[\\/]Cookies([\\/]|$)/i,
  /[\\/]Local Settings([\\/]|$)/i,
  /[\\/]My Documents([\\/]|$)/i,
  /[\\/]NetHood([\\/]|$)/i,
  /[\\/]PrintHood([\\/]|$)/i,
  /[\\/]Recent([\\/]|$)/i,
  /[\\/]SendTo([\\/]|$)/i,
  /[\\/]Start Menu([\\/]|$)/i,
  /[\\/]Templates([\\/]|$)/i,
];

/**
 * Returns true when `dir` is a Windows path we should never recursively
 * watch — the user's profile root, a drive root, or a known system
 * directory. Those locations contain legacy reparse-point junctions
 * that make chokidar's per-directory `fs.watch` throw EPERM during
 * traversal (see issue #43).
 *
 * Pure / platform-agnostic so it can be exercised in tests on macOS
 * — the caller decides whether to invoke it (we only run it when
 * `process.platform === 'win32'`).
 */
export function isUnsafeWindowsWatchRoot(dir: string, homedir: string): boolean {
  const norm = (p: string): string =>
    p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const cwd = norm(dir);
  const home = norm(homedir);

  if (cwd === home) return true;

  // Drive root, e.g. `c:` or `c:\`.
  if (/^[a-z]:$/.test(cwd)) return true;

  // Known Windows system roots that contain junctions / reparse points.
  const sysRoots = [
    'c:\\windows',
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\programdata',
  ];
  for (const root of sysRoots) {
    if (cwd === root || cwd.startsWith(root + '\\')) return true;
  }
  return false;
}

/**
 * Test seam — lets vitest stub the chokidar load without going through
 * Node's module cache. The default loads the real package; tests can
 * `vi.spyOn(_chokidarSeam, 'load')`.
 */
export const _chokidarSeam = {
  load: (): ChokidarLike | null => {
    try {
      return require('chokidar') as ChokidarLike;
    } catch {
      return null;
    }
  },
};

export class FileWatcherService {
  private watcher: FileWatcher | null = null;
  private readonly pending = new Map<string, PendingFile>();
  private readonly apiBase: string;
  private stopped = false;

  constructor(private readonly opts: FileWatcherOptions) {
    this.apiBase = opts.apiBaseUrl ?? API_BASE;
  }

  /**
   * Start watching `opts.workingDir`. Idempotent (second call is a
   * no-op). Resolves once chokidar's initial scan completes; that
   * way the `start.ts` orchestrator can sequence "agent up → watcher
   * ready" deterministically if it wants to, though today it
   * doesn't await this.
   */
  async start(): Promise<void> {
    if (this.watcher) return;
    if (this.stopped) {
      // A stopped watcher is single-use; create a new instance.
      throw new Error('FileWatcherService has already been stopped — re-instantiate to restart.');
    }

    const isWin = process.platform === 'win32';

    // Windows users frequently launch a shell at `C:\Users\<name>` — the
    // default cmd.exe / PowerShell starting directory. Recursively watching
    // a user profile is both useless for project work and unsafe: the
    // legacy WinXP-compat junctions (`Application Data`, `Cookies`, …)
    // have a DENY ACL that makes chokidar's per-directory `fs.watch`
    // throw EPERM during traversal (issue #43).
    if (isWin && isUnsafeWindowsWatchRoot(this.opts.workingDir, os.homedir())) {
      log.warn(
        'fileWatcher',
        `refusing to watch ${this.opts.workingDir} — looks like a Windows user-profile or system path. Run codeam from your project folder to enable file change emission.`,
      );
      return;
    }

    // Test seam wraps the dynamic require so a chokidar load failure
    // (corrupt install, sandboxed environment) degrades to a logged
    // warning rather than crashing the agent boot path.
    const chokidar = _chokidarSeam.load();
    if (!chokidar) {
      log.warn(
        'fileWatcher',
        `chokidar unavailable — file change emission disabled`,
      );
      return;
    }

    const watcher = chokidar.watch(this.opts.workingDir, {
      ignored: [
        /(^|[\\/])\../, // dot-files & dot-dirs (.git, .next, .expo, .DS_Store, …)
        /node_modules/,
        /dist/,
        /build/,
        /out/,
        /coverage/,
        /\.turbo/,
        /\.cache/,
        /\.parcel-cache/,
        // Build outputs that aren't a typical "dist" target
        /target\//,
        /__pycache__/,
        // Windows-only: skip legacy user-profile junctions whose ACLs
        // throw EPERM during chokidar's recursive traversal.
        ...(isWin ? WINDOWS_LEGACY_JUNCTIONS : []),
      ],
      ignoreInitial: true, // we only care about post-start changes
      persistent: true,
      // Windows-only safety net: don't follow reparse points, and let
      // chokidar swallow EPERM/EACCES on unreadable paths instead of
      // bubbling them up as fatal errors. Both are no-ops on macOS
      // (fsevents traversal doesn't fail on permission errors).
      ...(isWin
        ? {
            followSymlinks: false,
            ignorePermissionErrors: true,
          }
        : {}),
      awaitWriteFinish: {
        // Coalesces rapid sequential writes (npm install spam, build
        // tools emitting bursts). Lower than chokidar's default so
        // the user sees their Files screen update within 0.5 s of
        // saving.
        stabilityThreshold: 150,
        pollInterval: 50,
      },
    });

    watcher.on('add', (filePath: string) => this.schedule(filePath, 'add'));
    watcher.on('change', (filePath: string) => this.schedule(filePath, 'change'));
    watcher.on('unlink', (filePath: string) => this.schedule(filePath, 'unlink'));

    // chokidar bubbles fs errors through Node's EventEmitter `error`
    // event. Without a listener Node terminates the process — which is
    // exactly the v2.16.1 Windows crash (#43) where descending into
    // `C:\Users\<u>\Application Data` threw EPERM. Logging and
    // continuing is the right policy for a best-effort file producer.
    watcher.on('error', (err: unknown) => {
      const code = (err as { code?: string } | null)?.code ?? 'unknown';
      log.warn(
        'fileWatcher',
        `chokidar error (code=${code}) — watcher continues: ${err}`,
      );
    });

    this.watcher = watcher;
    log.info(
      'fileWatcher',
      `watching ${this.opts.workingDir} for session=${this.opts.sessionId.slice(0, 8)}`,
    );
  }

  /**
   * Stop watching. Idempotent — safe to call multiple times. After
   * stop, the instance is dead; create a new one to resume. (This
   * matches the `OutputService` / `CommandRelayService` style.)
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch (err) {
        log.warn('fileWatcher', 'error closing chokidar', err);
      }
      this.watcher = null;
    }
    log.info('fileWatcher', `stopped (session=${this.opts.sessionId.slice(0, 8)})`);
  }

  /**
   * Coalesce rapid writes per-file. Each fresh event resets the
   * 250 ms debounce timer. When the timer fires, we compute the
   * diff once and emit.
   *
   * `unlink` events bypass the diff path — we emit a synthetic
   * deletion directly because `git diff <path>` for a removed file
   * produces a diff that's already encoded as a deletion in
   * `parseUnifiedDiff`, but in practice the file is gone and the
   * synthetic path is simpler and avoids a race with git's index.
   */
  private schedule(absPath: string, changeType: 'add' | 'change' | 'unlink'): void {
    if (this.stopped) return;

    const existing = this.pending.get(absPath);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.pending.delete(absPath);
      void this.emitForFile(absPath, changeType);
    }, DEBOUNCE_MS);

    this.pending.set(absPath, {
      lastEventAt: Date.now(),
      timer,
      changeType,
    });
  }

  /**
   * Visible for tests — lets vitest pump a synthetic file event
   * through the debounce + diff + emit pipeline without spinning up
   * a real chokidar watcher.
   */
  /* @internal */ _scheduleForTest(absPath: string, changeType: 'add' | 'change' | 'unlink'): void {
    this.schedule(absPath, changeType);
  }

  private async emitForFile(absPath: string, changeType: 'add' | 'change' | 'unlink'): Promise<void> {
    if (this.stopped) return;

    const relPath = path.relative(this.opts.workingDir, absPath);
    if (!relPath || relPath.startsWith('..')) {
      // Belt-and-suspenders: chokidar should only fire under the
      // watched root, but if a symlink escapes we don't want to
      // ship a path outside the project to the backend.
      return;
    }

    let diffText = '';
    let fileStatus: FileChangeStatus = 'modified';

    if (changeType === 'unlink') {
      // The file is gone — git diff will work as long as the file
      // was tracked, otherwise we synthesize a minimal deletion.
      const diff = await this.gitDiff(relPath);
      if (diff !== null && diff.trim().length > 0) {
        diffText = diff;
      } else {
        // Untracked-and-removed: nothing to compute against. Just
        // emit the file-changed event with zero stats.
        await this.postFileChanged({
          sessionId: this.opts.sessionId,
          pluginId: this.opts.pluginId,
          filePath: relPath,
          fileStatus: 'deleted',
          linesAdded: 0,
          linesRemoved: 0,
          hunkCount: 0,
        });
        return;
      }
      fileStatus = 'deleted';
    } else {
      const diff = await this.gitDiff(relPath);
      if (diff === null) {
        // `git diff` failed (e.g. cwd is not a git repo). Skip
        // hunks; emit a best-effort file-changed event so the Files
        // screen still surfaces the path.
        log.warn(
          'fileWatcher',
          `git diff failed for ${relPath} — emitting file-changed only`,
        );
        await this.postFileChanged({
          sessionId: this.opts.sessionId,
          pluginId: this.opts.pluginId,
          filePath: relPath,
          fileStatus: changeType === 'add' ? 'added' : 'modified',
          linesAdded: 0,
          linesRemoved: 0,
          hunkCount: 0,
        });
        return;
      }
      diffText = diff;
    }

    const parsed = parseUnifiedDiff(diffText);
    // Prefer the diff-derived status when available; fall back to
    // the chokidar event when the diff is empty (e.g. a touch that
    // didn't change content).
    const finalStatus: FileChangeStatus =
      parsed.fileStatus !== 'modified'
        ? parsed.fileStatus
        : changeType === 'add'
          ? 'added'
          : changeType === 'unlink'
            ? 'deleted'
            : fileStatus;

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
    });

    // Aggressive review policy — every hunk to the queue.
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
   * Compute the unified diff for a single path relative to the
   * working dir. Returns `null` when git is unavailable or the cwd
   * is not a repo. Returns `''` when there's no diff (a touch that
   * didn't change content).
   *
   * For tracked files we use `git diff --no-color -- <path>` which
   * compares the worktree against HEAD's blob.
   * For untracked files (`git ls-files --error-unmatch` exits non-
   * zero) we use `git diff --no-color --no-index /dev/null <path>`,
   * which produces an "added"-shaped diff against an empty source.
   */
  private async gitDiff(relPath: string): Promise<string | null> {
    // First try the tracked-file path. If `git diff` returns empty
    // AND the file is untracked, fall through to the --no-index
    // variant. We don't pre-check with `ls-files` because that's a
    // second subprocess — checking the diff output is cheaper.
    const tracked = await runGit(
      this.opts.workingDir,
      ['diff', '--no-color', '--', relPath],
    );
    if (tracked === null) return null; // git failed entirely
    if (tracked.trim().length > 0) return tracked;

    // Empty diff → either no change or untracked. Try --no-index
    // against /dev/null which always produces a diff for an existing
    // file. The exit code for --no-index is non-zero when files
    // differ (which is exactly our case), so runGit returns the
    // output regardless of exit code.
    const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const untracked = await runGit(
      this.opts.workingDir,
      ['diff', '--no-color', '--no-index', '--', devNull, relPath],
      { allowNonZeroExit: true },
    );
    return untracked ?? '';
  }

  private async postFileChanged(body: FileChangedEvent): Promise<void> {
    await this.postWithRetries(`${this.apiBase}/api/files/changed`, body);
  }

  private async postReviewHunk(body: PendingReviewHunkEvent): Promise<void> {
    await this.postWithRetries(`${this.apiBase}/api/review/hunks`, body);
  }

  private async postWithRetries(
    url: string,
    body: FileChangedEvent | PendingReviewHunkEvent,
  ): Promise<void> {
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Codeam-Protocol-Version': '2.0.0',
      'X-Plugin-Auth-Token': this.opts.pluginAuthToken,
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const { statusCode, body: resBody } = await _transport.post(url, headers, payload);
        if (statusCode >= 200 && statusCode < 300) {
          log.trace(
            'fileWatcher',
            `post ok url=${url} status=${statusCode} path=${body.filePath}`,
          );
          return;
        }
        if (statusCode === 410 || statusCode === 404) {
          // Session is gone — stop trying for the rest of the run.
          // We don't `stop()` the watcher (the host owns lifecycle),
          // but no point hammering a dead session.
          log.warn(
            'fileWatcher',
            `session dead (status=${statusCode}) — dropping ${body.filePath}`,
          );
          this.stopped = true;
          return;
        }
        log.warn(
          'fileWatcher',
          `post failed url=${url} status=${statusCode} attempt=${attempt + 1} body=${resBody.slice(0, 200)}`,
        );
      } catch (err) {
        log.warn(
          'fileWatcher',
          `post error url=${url} attempt=${attempt + 1}`,
          err,
        );
      }
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
      }
    }
    log.warn(
      'fileWatcher',
      `giving up after ${MAX_RETRIES + 1} attempts — path=${body.filePath}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Spawn `git` with the given args, capture stdout. Returns `null`
 * when git isn't available or the spawn fails outright. Returns the
 * stdout (which may be empty) on success. When `allowNonZeroExit`
 * is true, non-zero exits still resolve with the captured stdout —
 * this is required for `git diff --no-index` which exits with 1
 * when files differ.
 *
 * Exposed via `_runGit` for tests; the default `runGit` is the
 * production implementation.
 */
async function runGit(
  cwd: string,
  args: string[],
  opts: { allowNonZeroExit?: boolean } = {},
): Promise<string | null> {
  return _runGit(cwd, args, opts);
}

/** Test seam. */
export const _gitSeam = {
  run: _runGitImpl,
};

async function _runGitImpl(
  cwd: string,
  args: string[],
  opts: { allowNonZeroExit?: boolean } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('git', args, { cwd, env: process.env });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', (code: number | null) => {
      if (code === 0 || opts.allowNonZeroExit) {
        resolve(stdout);
      } else {
        log.trace('fileWatcher', `git ${args.join(' ')} exited ${code} stderr=${stderr.slice(0, 200)}`);
        resolve(null);
      }
    });
  });
}

function _runGit(
  cwd: string,
  args: string[],
  opts: { allowNonZeroExit?: boolean } = {},
): Promise<string | null> {
  return _gitSeam.run(cwd, args, opts);
}

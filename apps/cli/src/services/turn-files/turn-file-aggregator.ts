import { randomUUID } from 'crypto';
import { resolveApiBaseUrl, PROTOCOL_VERSION } from '@codeam/shared';
import { _transport } from '../file-watcher/transport';
import { log } from '../logger';
import {
  collectRepoChangeset,
  discoverRepos,
  type ChangesetEntry,
  type RepoDescriptor,
} from './git-changeset';
import { FilesOutbox, type OutboxEntry } from './files-outbox';
import type { RepoDirtyTracker } from './repo-dirty-tracker';

export interface TurnFileAggregatorOptions {
  workingDir: string;
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  /** The agent currently running this session (e.g. `'claude'` /
   *  `'codex'`). Sent in the batch payload so the backend can decide
   *  whether to fire the AI Summary trigger based on the user's
   *  LinkedAgent.aiInsightsEnabled setting. */
  agentId?: string;
  /** Override the API base URL — defaults to the resolved prod / dev
   *  URL. Tests pass a fake. */
  apiBaseUrl?: string;
  /** Optional outbox-dir override. Production leaves it null. */
  outboxDir?: string;
  /**
   * Disable the outbox's auto-scheduled flush. Tests set this so the
   * `setTimeout(0)` enqueue chain doesn't leak across spec files
   * (the in-flight flush could otherwise touch the next file's
   * `vi.spyOn(_transport, 'post')` after `restoreAllMocks` ran).
   * Production omits — the flush loop is essential to drain the
   * outbox after a network blip.
   */
  outboxAutoSchedule?: boolean;
  /**
   * Optional tracker that records which repos saw filesystem
   * activity since the last flush. When present, `flushTurn()`
   * only spawns `git status` / `git diff --numstat` for repos
   * in the dirty set instead of every discovered repo. Pure
   * optimisation — leaving it unset (the default) preserves the
   * "scan everything" behaviour from v2.21.0.
   */
  dirtyTracker?: RepoDirtyTracker;
}

const API_BASE = resolveApiBaseUrl();
const ENDPOINT = '/api/files/batch';
const MAX_BATCH_SIZE = 1000; // matches BatchFilesChangedDto cap

/**
 * End-of-turn changeset aggregator + batch poster. Replaces the
 * legacy per-save / per-file POSTs with ONE request per turn:
 *
 *   1. On construction, walk `workingDir` to discover every git
 *      repo inside (depth-bounded, multi-repo workspaces light up).
 *   2. On `flushTurn()` (called by OutputService.onTurnComplete),
 *      collect each repo's changeset via two git subprocesses, build
 *      one BatchFilesChangedDto payload, and ship it.
 *   3. On network failure, the outbox persists the payload and
 *      retries with exponential backoff. The backend's turnId-keyed
 *      SETNX de-dups the eventual retry.
 *
 * The legacy chokidar `FileWatcherService` can stay running alongside
 * this — its emissions just turn into idempotent upserts when a turn
 * lands. A follow-up will gate it behind a flag once we trust the
 * aggregator in production for a release cycle.
 */
export class TurnFileAggregator {
  private readonly apiBase: string;
  private readonly outbox: FilesOutbox;
  private repos: RepoDescriptor[] = [];
  private discovering: Promise<void> | null = null;
  private stopped = false;

  /**
   * Pre-pair worktree baseline. Captured lazily on the first
   * `flushTurn()` call by running the same `git status` / `git diff`
   * scan the regular flush uses, then stashing the result here
   * WITHOUT enqueuing the outbox. Every subsequent flush diff-checks
   * its entries against this map and only emits files that are
   * absent from the baseline OR whose `linesAdded` / `linesRemoved`
   * have moved.
   *
   * Why: the legacy first-flush behaviour shipped the entire dirty
   * worktree at session start, which attributed pre-existing
   * uncommitted edits to the brand-new sessionId (and confusingly
   * showed them on the new session's rail with zero hunks, because
   * the chokidar watcher never saw the changes — they happened
   * before the watcher booted). Capturing the baseline silently
   * keeps the rail honest: it now means "files THIS session changed".
   *
   * Key is `${repoPath}|${filePath}` so a sibling repo with the same
   * relative path doesn't collide with another one.
   */
  private baselineByKey: Map<string, ChangesetEntry> = new Map();
  private baselineCaptured = false;

  /**
   * The file paths (relative to their repo root) that the MOST RECENT
   * `flushTurn()` call found novel — i.e. what it just enqueued (or would
   * have enqueued had the batch not exactly matched the baseline). Updated
   * unconditionally on every flush, including a no-op one (empties back
   * out), so `peekTurnPaths()` never returns paths from more than one
   * flush cycle ago. Not touched by the baseline-capture flush (it returns
   * before `novel` is computed), which is correct — pre-pair files aren't
   * "this session's" changes.
   */
  private lastTurnPaths: string[] = [];

  constructor(private readonly opts: TurnFileAggregatorOptions) {
    this.apiBase = opts.apiBaseUrl ?? API_BASE;
    this.outbox = new FilesOutbox({
      sessionId: opts.sessionId,
      baseDir: opts.outboxDir,
      post: (entry) => this.postEntry(entry),
      autoSchedule: opts.outboxAutoSchedule,
    });
    // Discover repos eagerly but don't block construction — the first
    // `flushTurn()` awaits this Promise so the discovery only blocks
    // if a turn finishes faster than the filesystem walk.
    this.discovering = discoverRepos(opts.workingDir).then((repos) => {
      this.repos = repos;
      // Seed every discovered repo as dirty so the FIRST flush
      // captures pre-pair worktree state (un-committed edits made
      // before the user paired). Subsequent flushes start clean and
      // grow back via watcher events.
      opts.dirtyTracker?.markAllDirty(repos);
      log.info(
        'turnFiles',
        `discovered ${repos.length} repo(s) under ${opts.workingDir}: ${repos
          .map((r) => r.repoName || '<root>')
          .join(', ')}`,
      );
    });
  }

  /** Stop the outbox scheduler. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.outbox.stop();
  }

  /**
   * Non-destructive read of the paths the MOST RECENT `flushTurn()` call
   * found novel — does NOT trigger a scan or clear anything itself. The
   * squad journal (`recordSquadTurn` in `command-handlers.ts`) `await`s
   * `flushTurn()` for the turn it's about to record BEFORE calling this, so
   * the read reflects THAT turn's paths, not a stale one left over from
   * whatever flushed previously. Empty on a session's very first turn
   * (still capturing the pre-pair baseline) or a chat-only turn.
   */
  peekTurnPaths(): string[] {
    return [...this.lastTurnPaths];
  }

  /**
   * Run the discovery + git collection + POST pipeline for one
   * turn. Errors are swallowed (logged) so an agent never blocks on a
   * file-changeset failure; the outbox covers the network half.
   */
  async flushTurn(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.discovering) {
        await this.discovering;
        this.discovering = null;
      }
      if (this.repos.length === 0) {
        log.trace('turnFiles', 'no repos discovered — skipping flush');
        return;
      }

      // When a dirty tracker is wired in, narrow the scan to the
      // repos that saw filesystem activity since the last flush. A
      // chat-only turn (no edits) leaves the dirty set empty and
      // short-circuits before spawning git at all. Without a
      // tracker we fall back to scanning every discovered repo.
      const reposToScan = this.opts.dirtyTracker
        ? this.filterByDirty(this.opts.dirtyTracker)
        : this.repos;

      if (reposToScan.length === 0) {
        log.trace('turnFiles', 'dirty set empty — skipping flush');
        return;
      }

      const files: ChangesetEntry[] = [];
      for (const repo of reposToScan) {
        const entries = await collectRepoChangeset(repo);
        if (entries) files.push(...entries);
      }

      // FIRST flush after construction — stash the current dirty
      // state as the pre-pair baseline and skip the POST. The rail
      // should never claim ownership of files that were already
      // dirty when the user paired; the chokidar watcher covers
      // live edits during the session, and subsequent flushes diff
      // against this baseline so only the deltas reach the backend.
      if (!this.baselineCaptured) {
        this.baselineByKey = new Map(files.map((f) => [baselineKey(f), f]));
        this.baselineCaptured = true;
        log.info(
          'turnFiles',
          `baseline captured: ${files.length} pre-pair file(s) — suppressing initial POST`,
        );
        return;
      }

      const novel = files.filter((f) => {
        const base = this.baselineByKey.get(baselineKey(f));
        if (!base) return true; // file appeared after pairing
        return (
          base.linesAdded !== f.linesAdded ||
          base.linesRemoved !== f.linesRemoved ||
          base.fileStatus !== f.fileStatus
        );
      });
      this.lastTurnPaths = novel.map((f) => f.filePath);

      if (novel.length === 0) {
        log.trace(
          'turnFiles',
          `flush matched baseline exactly — skipping POST (scanned=${files.length})`,
        );
        return;
      }

      // Hard cap so a pathological turn (e.g. mass refactor) doesn't
      // exceed the backend's per-batch limit. Split into chunks if it
      // does happen; each chunk gets its own turnId so the backend
      // upserts them independently.
      const chunks = chunkArray(novel, MAX_BATCH_SIZE);
      for (const chunk of chunks) {
        const entry: OutboxEntry = {
          turnId: randomUUID(),
          sessionId: this.opts.sessionId,
          pluginId: this.opts.pluginId,
          enqueuedAt: Date.now(),
          files: chunk,
        };
        await this.outbox.enqueue(entry);
      }
    } catch (err) {
      log.warn('turnFiles', `flushTurn failed: ${(err as Error).message ?? String(err)}`);
    }
  }

  /**
   * Consume the tracker's dirty set and intersect with the
   * discovered repos so we never spawn git for a path the watcher
   * marked outside our discovered set (e.g. a sibling repo that
   * appeared after construction). Unknown roots get dropped on the
   * floor — they'll re-mark themselves on the next event if they're
   * inside `workingDir`.
   */
  private filterByDirty(tracker: RepoDirtyTracker): RepoDescriptor[] {
    const dirty = tracker.consume();
    if (dirty.size === 0) return [];
    return this.repos.filter((repo) => dirty.has(repo.repoRoot));
  }

  private async postEntry(entry: OutboxEntry): Promise<{ ok: boolean; statusCode: number }> {
    const url = `${this.apiBase}${ENDPOINT}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Codeam-Protocol-Version': PROTOCOL_VERSION,
      'X-Plugin-Auth-Token': this.opts.pluginAuthToken,
    };
    const body = JSON.stringify({
      sessionId: entry.sessionId,
      pluginId: entry.pluginId,
      turnId: entry.turnId,
      agentId: this.opts.agentId,
      files: entry.files,
    });
    try {
      const res = await _transport.post(url, headers, body);
      return { ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode };
    } catch (err) {
      log.trace(
        'turnFiles',
        `batch POST threw turnId=${entry.turnId.slice(0, 8)}: ${(err as Error).message}`,
      );
      return { ok: false, statusCode: 0 };
    }
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (arr.length <= size) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** Composite key for the baseline map. `repoPath` disambiguates a
 *  sibling repo that happens to ship the same relative path (e.g.
 *  `README.md` in two sibling repos under a multi-repo workspace). */
function baselineKey(entry: ChangesetEntry): string {
  return `${entry.repoPath}|${entry.filePath}`;
}

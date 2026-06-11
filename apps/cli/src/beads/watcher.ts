import * as crypto from 'crypto';
import * as path from 'path';
import { resolveApiBaseUrl } from '@codeagent/shared';
import type { BeadsIngestPayload, BeadsStatusSummary } from '@codeagent/shared';
import { BdAdapter } from './bd-adapter';
import { deriveProjectIdentity } from './project-key';
import { _transport } from '../services/file-watcher/transport';
import { log } from '../services/logger';

/**
 * Watches the Beads change feed (`<home>/.beads/issues.jsonl`, auto-exported by
 * bd after every write — enabled in bootstrap) and pushes a full
 * `BeadsIngestPayload` snapshot to the backend whenever it changes.
 *
 * Realtime discipline (repo rule + spec §4.3): the watcher reacts to the
 * filesystem event ONLY. It never polls `bd ready` / `bd list` on a timer —
 * the only thing on a clock here is the debounce that coalesces a burst of
 * writes (an agent closing several issues in one turn) into a single push.
 *
 * The snapshot is built by querying the adapter (`bd list --json` +
 * `bd status --json`) after the file settles, then POSTed with plugin auth
 * (X-Plugin-Auth-Token) — the CLI has no user JWT. A content hash of the last
 * pushed payload short-circuits redundant POSTs (the file can be rewritten
 * with identical content, e.g. a no-op `bd config`).
 */

const API_BASE = resolveApiBaseUrl();
const DEBOUNCE_MS = 400;

/** Sent in place of a null `bd status --json` so `summary` is never omitted. */
const ZERO_SUMMARY: BeadsStatusSummary = {
  open_issues: 0,
  ready_issues: 0,
  blocked_issues: 0,
  in_progress_issues: 0,
  closed_issues: 0,
  total_issues: 0,
};

export interface BeadsWatcherOptions {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  /** User's project working dir — drives the D7 projectKey. */
  cwd?: string;
  /** Shared adapter (reuses the resolved binary + home-brain wiring). */
  adapter?: BdAdapter;
  /** Override the watched issues.jsonl path (tests / non-default home). */
  feedPath?: string;
  /** Override API base (tests). */
  apiBaseUrl?: string;
  /** Test isolation for the adapter. */
  beadsDir?: string;
}

/** Minimal chokidar surface (mirrors file-watcher.service's inline type). */
interface FeedWatcher {
  on(event: 'add' | 'change', handler: (p: string) => void): this;
  on(event: 'error', handler: (err: unknown) => void): this;
  close(): Promise<void>;
}
interface ChokidarLike {
  watch(paths: string, opts: Record<string, unknown>): FeedWatcher;
}

/** Test seam — stub the chokidar load without touching Node's module cache. */
export const _chokidarSeam = {
  load: (): ChokidarLike | null => {
    try {
      return require('chokidar') as ChokidarLike;
    } catch {
      return null;
    }
  },
};

export class BeadsWatcher {
  private watcher: FeedWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastPushedHash: string | null = null;
  private readonly bd: BdAdapter;
  private readonly feedPath: string;
  private readonly apiBase: string;

  constructor(private readonly opts: BeadsWatcherOptions) {
    this.bd = opts.adapter ?? new BdAdapter({ cwd: opts.cwd, beadsDir: opts.beadsDir });
    // Under shared-server the project's `bd init` writes its workspace +
    // auto-exported `issues.jsonl` into `<cwd>/.beads/` (cwd-resolved), NOT
    // `~/.beads`. Watch the project's feed so issue mirroring tracks the right
    // file (D16). Tests/non-default homes can still override via feedPath.
    this.feedPath =
      opts.feedPath ?? path.join(opts.cwd ?? process.cwd(), '.beads', 'issues.jsonl');
    this.apiBase = opts.apiBaseUrl ?? API_BASE;
  }

  /** Start tailing the change feed. Idempotent (second call is a no-op). */
  start(): void {
    if (this.watcher || this.stopped) return;
    const chokidar = _chokidarSeam.load();
    if (!chokidar) {
      log.warn('beads', 'chokidar unavailable — beads watcher disabled');
      return;
    }
    const watcher = chokidar.watch(this.feedPath, {
      ignoreInitial: false, // push the current state once on start
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    watcher.on('add', () => this.scheduleSync());
    watcher.on('change', () => this.scheduleSync());
    watcher.on('error', (err) =>
      log.warn('beads', `feed watcher error — continuing: ${err}`),
    );
    this.watcher = watcher;
    log.info('beads', `watching ${this.feedPath} for session=${this.opts.sessionId.slice(0, 8)}`);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch (err) {
        log.warn('beads', 'error closing feed watcher', err);
      }
      this.watcher = null;
    }
  }

  /**
   * Debounce the filesystem event. Each fresh write resets the timer so a
   * burst of bd mutations coalesces into one snapshot push. NOT polling — the
   * timer only fires off the back of a real fs event.
   */
  private scheduleSync(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.syncNow();
    }, DEBOUNCE_MS);
  }

  /** Visible for tests — pump a synthetic feed event through debounce → push. */
  /* @internal */ _emitForTest(): void {
    this.scheduleSync();
  }

  /**
   * Build the full snapshot from bd and push it. Diffs against the last
   * pushed content hash so an identical rewrite is a no-op.
   */
  async syncNow(): Promise<void> {
    if (this.stopped) return;
    const { projectKey, projectLabel } = deriveProjectIdentity(this.opts.cwd);

    const [issues, summary] = await Promise.all([
      this.bd.listIssues(projectKey),
      this.bd.statusSummary(),
    ]);

    const payload: BeadsIngestPayload = {
      sessionId: this.opts.sessionId,
      pluginId: this.opts.pluginId,
      projectKey,
      projectLabel,
      fullSnapshot: true,
      issues,
      // The backend DTO requires `dependencies` (not `deps`). We don't track
      // edges in the P0 snapshot yet, so always send an empty array rather than
      // omitting the field (an omitted/conditional field 400s the ingest).
      dependencies: [],
      memories: [],
      // Always send a summary — a null `bd status` yields a zeroed block rather
      // than an omitted field, so the backend never has to special-case it.
      summary: summary ?? ZERO_SUMMARY,
    };

    const body = JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    if (hash === this.lastPushedHash) {
      log.trace('beads', 'snapshot unchanged — skipping push');
      return;
    }

    try {
      const res = await _transport.post(`${this.apiBase}/api/beads/ingest`, this.headers(), body);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        this.lastPushedHash = hash;
        log.trace('beads', `pushed ${issues.length} issue(s) project=${projectLabel}`);
      } else if (res.statusCode === 404 || res.statusCode === 410) {
        // Session gone — stop pushing for this run.
        log.warn('beads', `session dead (status=${res.statusCode}) — stopping watcher`);
        this.stopped = true;
      } else {
        log.warn('beads', `ingest failed status=${res.statusCode} body=${res.body.slice(0, 200)}`);
      }
    } catch (err) {
      log.warn('beads', 'ingest POST error', err);
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Codeam-Protocol-Version': '2.0.0',
      'X-Plugin-Auth-Token': this.opts.pluginAuthToken,
    };
  }
}

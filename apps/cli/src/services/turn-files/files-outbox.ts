import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { log } from '../logger';
import type { ChangesetEntry } from './git-changeset';

/**
 * One pending batch in the outbox. The producer signs the payload
 * with a `turnId` so the backend's SETNX idempotency gate de-dupes
 * outbox retries that race with a delayed-but-successful POST.
 */
export interface OutboxEntry {
  /** Stable, client-generated UUID per turn. */
  turnId: string;
  /** Backend session id. */
  sessionId: string;
  /** Per-pairing plugin id (HMAC-bound to pluginAuthToken). */
  pluginId: string;
  /** First-attempt time, used for stale-purge. */
  enqueuedAt: number;
  files: ChangesetEntry[];
}

const HOME_OUTBOX_DIR = '.codeam/outbox';

/** How long to keep entries before giving up entirely. 24 h matches
 *  the backend's snapshot TTL — past that the rail has rolled the
 *  row off anyway and reposting would just create stale data. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Exponential backoff schedule (ms). The flush loop walks down this
 *  list per retry; subsequent attempts stay at the cap. Each step has
 *  ±20% jitter applied at use-time to avoid thundering herds when N
 *  CLIs come back online after a shared network blip. */
const BACKOFF_STEPS_MS = [
  1_000, // 1 s
  2_000, // 2 s
  4_000, // 4 s
  8_000, // 8 s
  16_000, // 16 s
  32_000, // 32 s
  60_000, // 1 min
  120_000, // 2 min
  300_000, // 5 min — cap
];

export interface FilesOutboxOptions {
  sessionId: string;
  /**
   * Override the directory the outbox writes to. Defaults to
   * `~/.codeam/outbox/`. Tests pass a tmp dir; production callers
   * leave it alone.
   */
  baseDir?: string;
  /** Custom poster — production wires `_transport.post`; tests stub. */
  post: (entry: OutboxEntry) => Promise<{ ok: boolean; statusCode: number }>;
  /**
   * Disable the auto-schedule-on-enqueue setTimeout(0). Tests set
   * this true so the flush only fires when they explicitly call
   * `_flushNow()`, removing the timing race between fire-and-forget
   * scheduled flushes and assertion order. Production leaves it
   * unset (default false) so producers don't have to drive the
   * flush manually.
   */
  autoSchedule?: boolean;
}

/**
 * Append-only JSON-Lines outbox for end-of-turn batch payloads.
 *
 * Layout: one file per session at `<baseDir>/<sessionId>.jsonl`,
 * one JSON-encoded `OutboxEntry` per line. New batches append; the
 * flush loop reads every pending line, posts each, then COMPACTS by
 * rewriting only the unsent entries. The rewrite is atomic via a
 * tmp-file + rename so a crash mid-compaction never loses data.
 *
 * The outbox doesn't deduplicate by turnId — the backend's idempotency
 * SETNX is the canonical de-dup. Two retries for the same turnId both
 * land successfully (the second short-circuits server-side).
 *
 * No persistence between process restarts of OTHER state — the
 * scheduler timer is in-memory. On reboot the next `enqueue()`
 * triggers a flush which catches up everything that was on disk.
 */
export class FilesOutbox {
  private readonly filePath: string;
  private readonly post: FilesOutboxOptions['post'];
  private readonly autoSchedule: boolean;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private backoffIndex = 0;
  private stopped = false;

  constructor(opts: FilesOutboxOptions) {
    const base = opts.baseDir ?? path.join(homeDir(), HOME_OUTBOX_DIR);
    this.filePath = path.join(base, `${opts.sessionId}.jsonl`);
    this.post = opts.post;
    this.autoSchedule = opts.autoSchedule !== false;
  }

  /** Persist the entry to disk and trigger a flush. Returns once the
   *  line is durable on disk (not once the POST succeeds). */
  async enqueue(entry: OutboxEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    // Fresh enqueue resets the backoff — newer attempts shouldn't
    // inherit the cooldown of a previous failure window.
    this.backoffIndex = 0;
    if (this.autoSchedule) this.scheduleFlush(0);
  }

  /** Stop the scheduler. Idempotent. The on-disk file is left alone
   *  so the next process pickup can flush whatever's pending. */
  stop(): void {
    this.stopped = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Visible for tests. Forces a flush attempt right now. */
  async _flushNow(): Promise<void> {
    return this.flush();
  }

  private scheduleFlush(delayMs: number): void {
    if (this.stopped) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const jittered = delayMs === 0 ? 0 : applyJitter(delayMs);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, jittered);
  }

  private async flush(): Promise<void> {
    if (this.stopped) return;
    if (this.flushing) {
      // Re-entrancy guard. Another flush is in-flight; that one's
      // tail will re-schedule if anything's still queued.
      return;
    }
    this.flushing = true;
    try {
      const entries = await this.readAll();
      if (entries.length === 0) return;

      // Drop anything older than MAX_AGE_MS so a stuck flush doesn't
      // accumulate stale batches the rail has already aged out.
      const now = Date.now();
      const fresh = entries.filter((e) => now - e.enqueuedAt <= MAX_AGE_MS);
      if (fresh.length < entries.length) {
        log.warn(
          'turnFiles',
          `dropping ${entries.length - fresh.length} outbox entries older than ${MAX_AGE_MS / 1000}s`,
        );
      }

      const stillPending: OutboxEntry[] = [];
      let anyFailed = false;
      for (const entry of fresh) {
        if (this.stopped) {
          stillPending.push(entry);
          continue;
        }
        try {
          const res = await this.post(entry);
          if (res.ok) continue; // drop on success
          if (res.statusCode === 404 || res.statusCode === 410) {
            // Session is gone — no amount of retry helps. Drop the
            // entry so we don't grow the file forever.
            log.warn(
              'turnFiles',
              `session dead (status=${res.statusCode}); dropping turnId=${entry.turnId.slice(0, 8)}`,
            );
            continue;
          }
          // 5xx or transient — keep for next round.
          anyFailed = true;
          stillPending.push(entry);
        } catch (err) {
          anyFailed = true;
          stillPending.push(entry);
          log.trace(
            'turnFiles',
            `outbox post threw for turnId=${entry.turnId.slice(0, 8)}: ${
              (err as Error).message
            }`,
          );
        }
      }

      await this.rewrite(stillPending);

      if (anyFailed) {
        const delay = BACKOFF_STEPS_MS[Math.min(this.backoffIndex, BACKOFF_STEPS_MS.length - 1)];
        this.backoffIndex = Math.min(
          this.backoffIndex + 1,
          BACKOFF_STEPS_MS.length - 1,
        );
        this.scheduleFlush(delay);
      } else {
        this.backoffIndex = 0;
      }
    } finally {
      this.flushing = false;
    }
  }

  private async readAll(): Promise<OutboxEntry[]> {
    let raw = '';
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out: OutboxEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as OutboxEntry);
      } catch {
        // Malformed line — skip but don't lose the rest.
      }
    }
    return out;
  }

  /**
   * Atomic compaction: write to `<file>.tmp`, fsync, rename over the
   * original. A crash between any of these steps leaves either the
   * original (no progress) or the new file (clean compaction) — never
   * a torn write.
   */
  private async rewrite(entries: OutboxEntry[]): Promise<void> {
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    if (entries.length === 0) {
      // Clean state — drop the file outright.
      await fs.unlink(this.filePath).catch(() => undefined);
      return;
    }
    const payload = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(tmpPath, payload, 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }
}

function applyJitter(ms: number): number {
  const factor = 0.8 + Math.random() * 0.4; // [0.8, 1.2)
  return Math.round(ms * factor);
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? tmpdir();
}

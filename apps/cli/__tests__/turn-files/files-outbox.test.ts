import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { FilesOutbox, type OutboxEntry } from '../../src/services/turn-files/files-outbox';

/**
 * Integration-flavor specs for the JSONL outbox. The poster is
 * stubbed so we can drive specific HTTP outcomes (2xx, 5xx, network
 * throw, 410 session-dead) without spinning a real server.
 */
describe('FilesOutbox', () => {
  let baseDir: string;
  let sessionId: string;

  beforeEach(async () => {
    // Use REAL timers + drive flushes via the `_flushNow` test
    // hook. Fake timers + async fs I/O interact badly: the file
    // append resolves on a real microtask queue while
    // advanceTimersByTimeAsync only flushes the fake timer queue,
    // so flush() can race ahead of the on-disk state and read an
    // empty file. Tests stay deterministic by manually pumping
    // _flushNow() instead.
    baseDir = await fs.mkdtemp(path.join(tmpdir(), 'cli-outbox-'));
    sessionId = `sess-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  /**
   * Drain a few rounds of macro + micro tasks so any fire-and-forget
   * `setTimeout(0)` + chained `await` inside flush() actually
   * resolves before the assertions run.
   */
  async function drainMicrotasks(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  function makeEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
    return {
      turnId: overrides.turnId ?? 'turn-abc',
      sessionId: overrides.sessionId ?? sessionId,
      pluginId: 'plug-1',
      enqueuedAt: Date.now(),
      files: [
        {
          filePath: 'src/a.ts',
          fileStatus: 'modified',
          linesAdded: 1,
          linesRemoved: 0,
          hunkCount: 1,
          repoPath: '',
          repoName: 'demo',
        },
      ],
      ...overrides,
    };
  }

  it('drops the file when a single entry posts successfully', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, statusCode: 200 });
    const outbox = new FilesOutbox({ sessionId, baseDir, post, autoSchedule: false });

    await outbox.enqueue(makeEntry());
    await outbox._flushNow();

    expect(post).toHaveBeenCalledTimes(1);
    // File should be gone after a clean flush.
    await expect(
      fs.access(path.join(baseDir, `${sessionId}.jsonl`)),
    ).rejects.toThrow();
    outbox.stop();
  });

  it('keeps the entry on disk and schedules a retry on 5xx', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, statusCode: 500 })
      .mockResolvedValueOnce({ ok: true, statusCode: 200 });
    const outbox = new FilesOutbox({ sessionId, baseDir, post, autoSchedule: false });

    await outbox.enqueue(makeEntry());
    await outbox._flushNow();

    // Should still be on disk awaiting retry.
    const raw = await fs.readFile(
      path.join(baseDir, `${sessionId}.jsonl`),
      'utf8',
    );
    expect(raw.trim().split('\n')).toHaveLength(1);

    // Manually trigger the second flush — bypasses the backoff timer
    // which we don't want to wait through in unit speed.
    await outbox._flushNow();
    expect(post).toHaveBeenCalledTimes(2);
    await expect(
      fs.access(path.join(baseDir, `${sessionId}.jsonl`)),
    ).rejects.toThrow();
    outbox.stop();
  });

  it('drops 410 entries permanently without retry', async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ok: false, statusCode: 410 });
    const outbox = new FilesOutbox({ sessionId, baseDir, post, autoSchedule: false });

    await outbox.enqueue(makeEntry({ turnId: 'turn-gone' }));
    await outbox._flushNow();

    // Session-dead → entry dropped, file removed.
    expect(post).toHaveBeenCalledTimes(1);
    await expect(
      fs.access(path.join(baseDir, `${sessionId}.jsonl`)),
    ).rejects.toThrow();
    outbox.stop();
  });

  it('persists each enqueue as a separate JSONL line', async () => {
    const post = vi.fn().mockResolvedValue({ ok: false, statusCode: 500 });
    const outbox = new FilesOutbox({ sessionId, baseDir, post, autoSchedule: false });

    await outbox.enqueue(makeEntry({ turnId: 't-1' }));
    await outbox.enqueue(makeEntry({ turnId: 't-2' }));
    await outbox.enqueue(makeEntry({ turnId: 't-3' }));

    const raw = await fs.readFile(
      path.join(baseDir, `${sessionId}.jsonl`),
      'utf8',
    );
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).turnId).toBe('t-1');
    expect(JSON.parse(lines[2]).turnId).toBe('t-3');
    outbox.stop();
  });
});

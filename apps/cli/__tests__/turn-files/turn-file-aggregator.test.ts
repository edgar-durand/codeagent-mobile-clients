import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';

import { TurnFileAggregator } from '../../src/services/turn-files/turn-file-aggregator';
import { RepoDirtyTracker } from '../../src/services/turn-files/repo-dirty-tracker';
import * as gitChangeset from '../../src/services/turn-files/git-changeset';
import { _transport } from '../../src/services/file-watcher/transport';

/**
 * Black-box specs for the dirty-flag short-circuit. We stub
 * `discoverRepos` so the aggregator sees a deterministic set of
 * repos without scanning the filesystem, and `collectRepoChangeset`
 * so we can spy on which repos actually got scanned. `_transport.post`
 * is stubbed too so the outbox flush doesn't hit a real URL.
 */
describe('TurnFileAggregator + RepoDirtyTracker', () => {
  let outboxDir: string;

  beforeEach(async () => {
    outboxDir = await fs.mkdtemp(path.join(tmpdir(), 'cli-tfa-'));
    vi.spyOn(_transport, 'post').mockResolvedValue({
      statusCode: 200,
      body: '{}',
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(outboxDir, { recursive: true, force: true });
  });

  function stubDiscovery(repos: Array<{ repoRoot: string; repoPath: string; repoName: string }>): void {
    vi.spyOn(gitChangeset, 'discoverRepos').mockResolvedValue(repos);
  }

  it('scans every discovered repo on the FIRST flush (initial-dirty seed)', async () => {
    const collect = vi
      .spyOn(gitChangeset, 'collectRepoChangeset')
      .mockResolvedValue([
        {
          filePath: 'src/a.ts',
          fileStatus: 'modified',
          linesAdded: 1,
          linesRemoved: 0,
          hunkCount: 1,
          repoPath: '',
          repoName: 'demo',
        },
      ]);

    stubDiscovery([
      { repoRoot: '/repos/a', repoPath: 'a', repoName: 'a' },
      { repoRoot: '/repos/b', repoPath: 'b', repoName: 'b' },
    ]);

    const tracker = new RepoDirtyTracker();
    const agg = new TurnFileAggregator({
      workingDir: '/repos',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'tok',
      apiBaseUrl: 'https://api.example.test',
      outboxDir,
      dirtyTracker: tracker,
      outboxAutoSchedule: false,
    });

    await agg.flushTurn();

    // Both repos got scanned because the constructor seeded the
    // tracker with `markAllDirty` post-discovery.
    expect(collect).toHaveBeenCalledTimes(2);
    agg.stop();
  });

  it('skips repos that did NOT see a filesystem event between turns', async () => {
    const collect = vi
      .spyOn(gitChangeset, 'collectRepoChangeset')
      .mockResolvedValue([]);

    stubDiscovery([
      { repoRoot: '/repos/a', repoPath: 'a', repoName: 'a' },
      { repoRoot: '/repos/b', repoPath: 'b', repoName: 'b' },
      { repoRoot: '/repos/c', repoPath: 'c', repoName: 'c' },
    ]);

    const tracker = new RepoDirtyTracker();
    const agg = new TurnFileAggregator({
      workingDir: '/repos',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'tok',
      apiBaseUrl: 'https://api.example.test',
      outboxDir,
      dirtyTracker: tracker,
      outboxAutoSchedule: false,
    });

    // First flush drains the initial-dirty seed for all three.
    await agg.flushTurn();
    expect(collect).toHaveBeenCalledTimes(3);
    collect.mockClear();

    // Watcher fires for a single file under `/repos/b` between
    // turns. Only `b` should be scanned on the next flush.
    tracker.markDirty('/repos/b');
    await agg.flushTurn();
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls[0][0].repoRoot).toBe('/repos/b');

    agg.stop();
  });

  it('skips git entirely on a chat-only turn (no file events)', async () => {
    const collect = vi
      .spyOn(gitChangeset, 'collectRepoChangeset')
      .mockResolvedValue([]);

    stubDiscovery([{ repoRoot: '/repos/a', repoPath: 'a', repoName: 'a' }]);

    const tracker = new RepoDirtyTracker();
    const agg = new TurnFileAggregator({
      workingDir: '/repos',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'tok',
      apiBaseUrl: 'https://api.example.test',
      outboxDir,
      dirtyTracker: tracker,
      outboxAutoSchedule: false,
    });

    // First flush drains the seed.
    await agg.flushTurn();
    expect(collect).toHaveBeenCalledTimes(1);
    collect.mockClear();

    // No watcher events — the tracker is empty when the second
    // turn completes.
    await agg.flushTurn();
    expect(collect).toHaveBeenCalledTimes(0);

    agg.stop();
  });

  it('without a tracker falls back to scanning every discovered repo', async () => {
    const collect = vi
      .spyOn(gitChangeset, 'collectRepoChangeset')
      .mockResolvedValue([]);

    stubDiscovery([
      { repoRoot: '/repos/a', repoPath: 'a', repoName: 'a' },
      { repoRoot: '/repos/b', repoPath: 'b', repoName: 'b' },
    ]);

    const agg = new TurnFileAggregator({
      workingDir: '/repos',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'tok',
      apiBaseUrl: 'https://api.example.test',
      outboxDir,
      outboxAutoSchedule: false,
      // intentionally no dirtyTracker
    });

    await agg.flushTurn();
    expect(collect).toHaveBeenCalledTimes(2);
    await agg.flushTurn();
    // Still scans every repo on each call — legacy behaviour.
    expect(collect).toHaveBeenCalledTimes(4);

    agg.stop();
  });
});

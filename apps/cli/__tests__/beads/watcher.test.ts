import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BeadsWatcher, _chokidarSeam } from '../../src/beads/watcher';
import { _transport } from '../../src/services/file-watcher/transport';
import * as projectKey from '../../src/beads/project-key';
import type { BdAdapter } from '../../src/beads/bd-adapter';
import type { BeadsIssueDto, BeadsStatusSummary } from '@codeagent/shared';

function makeIssue(id: string, status: BeadsIssueDto['status']): BeadsIssueDto {
  return {
    id,
    title: `issue ${id}`,
    status,
    priority: 1,
    issue_type: 'task',
    owner: null,
    created_at: '2026-06-09T10:00:00Z',
    updated_at: '2026-06-09T10:00:00Z',
    projectKey: 'github.com/edgar-durand/repo',
  };
}

const SUMMARY: BeadsStatusSummary = {
  open_issues: 1,
  ready_issues: 1,
  blocked_issues: 0,
  in_progress_issues: 0,
  closed_issues: 0,
  total_issues: 1,
};

/** Minimal fake adapter that returns a programmable issue list. */
function fakeAdapter(issues: BeadsIssueDto[]): BdAdapter {
  return {
    listIssues: vi.fn().mockResolvedValue(issues),
    statusSummary: vi.fn().mockResolvedValue(SUMMARY),
  } as unknown as BdAdapter;
}

function newWatcher(adapter: BdAdapter): BeadsWatcher {
  return new BeadsWatcher({
    sessionId: 'sess-123456',
    pluginId: 'plug-1',
    pluginAuthToken: 'secret-token',
    cwd: '/repo',
    adapter,
    feedPath: '/home/.beads/issues.jsonl',
    apiBaseUrl: 'https://api.test',
  });
}

describe('BeadsWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Stable projectKey so the payload + hash are deterministic.
    vi.spyOn(projectKey, 'deriveProjectIdentity').mockReturnValue({
      projectKey: 'github.com/edgar-durand/repo',
      projectLabel: 'repo',
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('debounces a burst of feed writes into a single POST', async () => {
    const post = vi
      .spyOn(_transport, 'post')
      .mockResolvedValue({ statusCode: 200, body: '{}' });
    const w = newWatcher(fakeAdapter([makeIssue('bd-1', 'open')]));

    // Three rapid writes within the debounce window.
    w._emitForTest();
    w._emitForTest();
    w._emitForTest();
    expect(post).not.toHaveBeenCalled(); // still within debounce

    await vi.advanceTimersByTimeAsync(400);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('POSTs a full BeadsIngestPayload with plugin auth to /api/beads/ingest', async () => {
    const post = vi
      .spyOn(_transport, 'post')
      .mockResolvedValue({ statusCode: 200, body: '{}' });
    const w = newWatcher(fakeAdapter([makeIssue('bd-1', 'in_progress')]));

    w._emitForTest();
    await vi.advanceTimersByTimeAsync(400);

    expect(post).toHaveBeenCalledTimes(1);
    const [url, headers, body] = post.mock.calls[0];
    expect(url).toBe('https://api.test/api/beads/ingest');
    expect(headers['X-Plugin-Auth-Token']).toBe('secret-token');
    const payload = JSON.parse(body);
    expect(payload.sessionId).toBe('sess-123456');
    expect(payload.projectKey).toBe('github.com/edgar-durand/repo');
    expect(payload.projectLabel).toBe('repo');
    expect(payload.fullSnapshot).toBe(true);
    expect(payload.issues).toHaveLength(1);
    expect(payload.issues[0].status).toBe('in_progress');
    expect(payload.summary.total_issues).toBe(1);
  });

  it('skips the POST when the snapshot is unchanged (diff short-circuit)', async () => {
    const post = vi
      .spyOn(_transport, 'post')
      .mockResolvedValue({ statusCode: 200, body: '{}' });
    const w = newWatcher(fakeAdapter([makeIssue('bd-1', 'open')]));

    w._emitForTest();
    await vi.advanceTimersByTimeAsync(400);
    expect(post).toHaveBeenCalledTimes(1);

    // Feed rewritten with identical content → no second POST.
    w._emitForTest();
    await vi.advanceTimersByTimeAsync(400);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('pushes again when the snapshot content actually changes', async () => {
    const post = vi
      .spyOn(_transport, 'post')
      .mockResolvedValue({ statusCode: 200, body: '{}' });
    const adapter = fakeAdapter([makeIssue('bd-1', 'open')]);
    const w = newWatcher(adapter);

    w._emitForTest();
    await vi.advanceTimersByTimeAsync(400);
    expect(post).toHaveBeenCalledTimes(1);

    // Issue transitions open → closed: new content, new hash.
    (adapter.listIssues as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeIssue('bd-1', 'closed'),
    ]);
    w._emitForTest();
    await vi.advanceTimersByTimeAsync(400);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('stops pushing after a 404/410 (session dead)', async () => {
    const post = vi
      .spyOn(_transport, 'post')
      .mockResolvedValue({ statusCode: 410, body: 'gone' });
    const adapter = fakeAdapter([makeIssue('bd-1', 'open')]);
    const w = newWatcher(adapter);

    w._emitForTest();
    await vi.advanceTimersByTimeAsync(400);
    expect(post).toHaveBeenCalledTimes(1);

    // Subsequent event is ignored — watcher marked stopped.
    w._emitForTest();
    await vi.advanceTimersByTimeAsync(400);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('start() loads chokidar and is idempotent', async () => {
    const watch = vi.fn().mockReturnValue({
      on() {
        return this;
      },
      close: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(_chokidarSeam, 'load').mockReturnValue({ watch });
    const w = newWatcher(fakeAdapter([]));
    w.start();
    w.start(); // idempotent
    expect(watch).toHaveBeenCalledTimes(1);
    await w.stop();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

import {
  FileWatcherService,
  _gitSeam,
} from '../src/services/file-watcher.service';
import { _transport } from '../src/services/file-watcher/transport';
import { parseUnifiedDiff } from '../src/services/file-watcher/diff-parser';

const WORKING_DIR = path.resolve('/tmp/fake-cwd');

function makeService(): FileWatcherService {
  return new FileWatcherService({
    workingDir: WORKING_DIR,
    sessionId: 'sess-abc',
    pluginId: 'plugin-1',
    pluginAuthToken: 'token-xyz',
    apiBaseUrl: 'https://api.example.test',
  });
}

describe('parseUnifiedDiff', () => {
  it('returns zeros on empty input', () => {
    const r = parseUnifiedDiff('');
    expect(r.hunks).toEqual([]);
    expect(r.totalLinesAdded).toBe(0);
    expect(r.totalLinesRemoved).toBe(0);
    expect(r.fileStatus).toBe('modified');
  });

  it('parses a modified file with one hunk', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      'index abc..def 100644',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      ' const d = 5;',
    ].join('\n');

    const r = parseUnifiedDiff(diff);
    expect(r.fileStatus).toBe('modified');
    expect(r.hunks.length).toBe(1);
    expect(r.totalLinesAdded).toBe(2);
    expect(r.totalLinesRemoved).toBe(1);
    expect(r.hunks[0].header).toBe('@@ -1,3 +1,4 @@');
    expect(r.hunks[0].lines.map((l) => l.type)).toEqual([
      'context', 'remove', 'add', 'add', 'context',
    ]);
    // Post-change gutter line numbers:
    //   context line 1 → 1
    //   removed line 2 → carries OLD line number 2
    //   added line 2   → new line 2
    //   added line 3   → new line 3
    //   context line 4 → 4
    expect(r.hunks[0].lines.map((l) => l.lineNumber)).toEqual([1, 2, 2, 3, 4]);
  });

  it('detects new file mode → added', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      'index 0000..abc',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two',
    ].join('\n');
    expect(parseUnifiedDiff(diff).fileStatus).toBe('added');
  });

  it('detects deleted file mode → deleted', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line one',
      '-line two',
    ].join('\n');
    expect(parseUnifiedDiff(diff).fileStatus).toBe('deleted');
  });

  it('detects rename → renamed', () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n');
    expect(parseUnifiedDiff(diff).fileStatus).toBe('renamed');
  });

  it('ignores "\\ No newline at end of file"', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ].join('\n');
    const r = parseUnifiedDiff(diff);
    expect(r.totalLinesAdded).toBe(1);
    expect(r.totalLinesRemoved).toBe(1);
    expect(r.hunks[0].lines.length).toBe(2);
  });

  it('parses multiple hunks in one diff', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,2 +1,2 @@',
      '-old1',
      '+new1',
      ' ctx',
      '@@ -10,2 +10,2 @@',
      '-old2',
      '+new2',
      ' ctx2',
    ].join('\n');
    const r = parseUnifiedDiff(diff);
    expect(r.hunks.length).toBe(2);
    expect(r.totalLinesAdded).toBe(2);
    expect(r.totalLinesRemoved).toBe(2);
  });
});

describe('FileWatcherService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('debounces rapid sequential change events into one emit', async () => {
    const svc = makeService();
    const gitSpy = vi.spyOn(_gitSeam, 'run').mockResolvedValue('');
    const postSpy = vi.spyOn(_transport, 'post').mockResolvedValue({
      statusCode: 200,
      body: '{}',
    });

    const absPath = path.join(WORKING_DIR, 'foo.ts');
    svc._scheduleForTest(absPath, 'change');
    svc._scheduleForTest(absPath, 'change');
    svc._scheduleForTest(absPath, 'change');

    // Debounce window = 250 ms — only one emit should fire after.
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTicks();

    // Expect 1 file-changed POST. Hunks list is empty (we returned
    // an empty diff) so no /review/hunks call.
    expect(postSpy.mock.calls.filter((c) => c[0].endsWith('/api/files/changed')).length).toBe(1);
    expect(postSpy.mock.calls.filter((c) => c[0].endsWith('/api/review/hunks')).length).toBe(0);
    expect(gitSpy).toHaveBeenCalled();
  });

  it('emits one file-changed + one hunk per parsed hunk', async () => {
    const svc = makeService();
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' ctx',
    ].join('\n');
    vi.spyOn(_gitSeam, 'run').mockResolvedValue(diff);
    const postSpy = vi.spyOn(_transport, 'post').mockResolvedValue({
      statusCode: 200,
      body: '{}',
    });

    svc._scheduleForTest(path.join(WORKING_DIR, 'foo.ts'), 'change');
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTicks();

    const filesCalls = postSpy.mock.calls.filter((c) => c[0].endsWith('/api/files/changed'));
    const hunksCalls = postSpy.mock.calls.filter((c) => c[0].endsWith('/api/review/hunks'));
    expect(filesCalls.length).toBe(1);
    expect(hunksCalls.length).toBe(1);

    const fileBody = JSON.parse(filesCalls[0][2]);
    expect(fileBody.sessionId).toBe('sess-abc');
    expect(fileBody.pluginId).toBe('plugin-1');
    expect(fileBody.filePath).toBe('foo.ts');
    expect(fileBody.fileStatus).toBe('modified');
    expect(fileBody.linesAdded).toBe(1);
    expect(fileBody.linesRemoved).toBe(1);
    expect(fileBody.hunkCount).toBe(1);
    expect(fileBody.reviewStatus).toBe('awaiting_review');

    const hunkBody = JSON.parse(hunksCalls[0][2]);
    expect(hunkBody.hunkHeader).toBe('@@ -1,2 +1,2 @@');
    expect(hunkBody.linesAdded).toBe(1);
    expect(hunkBody.linesRemoved).toBe(1);
    expect(hunkBody.lines.length).toBe(3);
  });

  it('sends X-Plugin-Auth-Token header on every emission', async () => {
    const svc = makeService();
    vi.spyOn(_gitSeam, 'run').mockResolvedValue('');
    const postSpy = vi.spyOn(_transport, 'post').mockResolvedValue({
      statusCode: 200,
      body: '{}',
    });

    svc._scheduleForTest(path.join(WORKING_DIR, 'foo.ts'), 'change');
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTicks();

    const headers = postSpy.mock.calls[0][1];
    expect(headers['X-Plugin-Auth-Token']).toBe('token-xyz');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Codeam-Protocol-Version']).toBe('2.0.0');
  });

  it('marks watcher as stopped on 410 to drop subsequent emissions', async () => {
    const svc = makeService();
    vi.spyOn(_gitSeam, 'run').mockResolvedValue('');
    const postSpy = vi.spyOn(_transport, 'post')
      .mockResolvedValueOnce({ statusCode: 410, body: '{}' });

    svc._scheduleForTest(path.join(WORKING_DIR, 'a.ts'), 'change');
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTicks();

    expect(postSpy).toHaveBeenCalledTimes(1);

    // Schedule another change — service is now in stopped state, no
    // further posts should fire.
    svc._scheduleForTest(path.join(WORKING_DIR, 'b.ts'), 'change');
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTicks();
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('retries with backoff on 500 then succeeds', async () => {
    const svc = makeService();
    vi.spyOn(_gitSeam, 'run').mockResolvedValue('');
    const postSpy = vi.spyOn(_transport, 'post')
      .mockResolvedValueOnce({ statusCode: 500, body: 'oops' })
      .mockResolvedValueOnce({ statusCode: 200, body: '{}' });

    svc._scheduleForTest(path.join(WORKING_DIR, 'a.ts'), 'change');
    // Debounce window (250 ms) + retry backoff (300 ms) + slack.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTicks();

    expect(postSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('emits a deletion event for unlinked files when git diff is empty', async () => {
    const svc = makeService();
    vi.spyOn(_gitSeam, 'run').mockResolvedValue('');
    const postSpy = vi.spyOn(_transport, 'post').mockResolvedValue({
      statusCode: 200,
      body: '{}',
    });

    svc._scheduleForTest(path.join(WORKING_DIR, 'gone.ts'), 'unlink');
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTicks();

    const fileCall = postSpy.mock.calls.find((c) => c[0].endsWith('/api/files/changed'));
    expect(fileCall).toBeDefined();
    const body = JSON.parse(fileCall![2]);
    expect(body.fileStatus).toBe('deleted');
    expect(body.hunkCount).toBe(0);
  });

  it('ignores symlink-escaped paths outside the working dir', async () => {
    const svc = makeService();
    const gitSpy = vi.spyOn(_gitSeam, 'run').mockResolvedValue('');
    const postSpy = vi.spyOn(_transport, 'post').mockResolvedValue({
      statusCode: 200,
      body: '{}',
    });

    svc._scheduleForTest('/etc/passwd', 'change');
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTicks();

    expect(postSpy).not.toHaveBeenCalled();
    expect(gitSpy).not.toHaveBeenCalled();
  });

  it('stop() clears pending timers and is idempotent', async () => {
    const svc = makeService();
    const gitSpy = vi.spyOn(_gitSeam, 'run').mockResolvedValue('');
    const postSpy = vi.spyOn(_transport, 'post').mockResolvedValue({
      statusCode: 200,
      body: '{}',
    });

    svc._scheduleForTest(path.join(WORKING_DIR, 'a.ts'), 'change');
    await svc.stop();
    await svc.stop(); // second call should not throw
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTicks();

    expect(postSpy).not.toHaveBeenCalled();
    expect(gitSpy).not.toHaveBeenCalled();
  });
});

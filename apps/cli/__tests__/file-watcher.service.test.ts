import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

import {
  FileWatcherService,
  _gitSeam,
  _chokidarSeam,
  _findGitRootSeam,
  isUnsafeWindowsWatchRoot,
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

describe('isUnsafeWindowsWatchRoot', () => {
  it('returns true for the Windows user-profile root', () => {
    expect(isUnsafeWindowsWatchRoot('C:\\Users\\Krzysztof', 'C:\\Users\\Krzysztof')).toBe(true);
  });

  it('returns true regardless of trailing separator / casing', () => {
    expect(isUnsafeWindowsWatchRoot('C:\\Users\\Krzysztof\\', 'C:\\Users\\KRZYSZTOF')).toBe(true);
    expect(isUnsafeWindowsWatchRoot('c:\\users\\krzysztof', 'C:\\Users\\Krzysztof')).toBe(true);
  });

  it('returns true for drive roots', () => {
    expect(isUnsafeWindowsWatchRoot('C:\\', 'C:\\Users\\bob')).toBe(true);
    expect(isUnsafeWindowsWatchRoot('D:', 'C:\\Users\\bob')).toBe(true);
  });

  it('returns true for known Windows system roots', () => {
    expect(isUnsafeWindowsWatchRoot('C:\\Windows', 'C:\\Users\\bob')).toBe(true);
    expect(isUnsafeWindowsWatchRoot('C:\\Program Files\\Foo', 'C:\\Users\\bob')).toBe(true);
    expect(isUnsafeWindowsWatchRoot('C:\\Program Files (x86)', 'C:\\Users\\bob')).toBe(true);
    expect(isUnsafeWindowsWatchRoot('C:\\ProgramData\\bar', 'C:\\Users\\bob')).toBe(true);
  });

  it('returns false for a real project directory under the user home', () => {
    expect(
      isUnsafeWindowsWatchRoot('C:\\Users\\Krzysztof\\projects\\demo', 'C:\\Users\\Krzysztof'),
    ).toBe(false);
  });
});

// Minimal one-hunk diff. Any of the tests that hit the HTTP path
// need a real diff body — empty stdout is now suppressed at source
// (no-op writes don't pollute the rail). Keep this tight so the
// expected counts in the existing assertions still hold.
const SAMPLE_DIFF = [
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
].join('\n');

describe('FileWatcherService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin the enclosing git root to WORKING_DIR. The production
    // implementation walks up looking for a real `.git/` directory;
    // the test fixture doesn't have one, so without this stub
    // emitForFile would suppress every event.
    vi.spyOn(_findGitRootSeam, 'resolve').mockImplementation((dir: string) =>
      dir.startsWith(WORKING_DIR) ? WORKING_DIR : null,
    );
  });
  afterEach(() => {
    // Drain every pending fake timer (HTTP retry backoffs from the
    // /review/hunks aggressive-policy loop) BEFORE switching the
    // clock or restoring mocks. Without this, a retry chain scheduled
    // in test N could fire its setTimeout continuation while test N+1
    // is busy and call into the new test's `_transport.post` spy,
    // surfacing as a phantom call. Windows CI hits this consistently
    // because msec-level timer alignment differs from macOS.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('debounces rapid sequential change events into one emit', async () => {
    const svc = makeService();
    const gitSpy = vi.spyOn(_gitSeam, 'run').mockResolvedValue(SAMPLE_DIFF);
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

    // Expect 1 file-changed POST + 1 /review/hunks for the single
    // hunk in SAMPLE_DIFF. The "Aggressive" policy posts every hunk.
    expect(postSpy.mock.calls.filter((c) => c[0].endsWith('/api/files/changed')).length).toBe(1);
    expect(postSpy.mock.calls.filter((c) => c[0].endsWith('/api/review/hunks')).length).toBe(1);
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
    vi.spyOn(_gitSeam, 'run').mockResolvedValue(SAMPLE_DIFF);
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
    vi.spyOn(_gitSeam, 'run').mockResolvedValue(SAMPLE_DIFF);
    const postSpy = vi.spyOn(_transport, 'post')
      .mockResolvedValueOnce({ statusCode: 410, body: '{}' });

    svc._scheduleForTest(path.join(WORKING_DIR, 'a.ts'), 'change');
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTicks();

    // First emit fires /files/changed; the 410 short-circuits the
    // retry loop AND poisons the service before any /review/hunks
    // post for the same file lands.
    const firstBatch = postSpy.mock.calls.length;
    expect(firstBatch).toBeGreaterThanOrEqual(1);

    // Schedule another change — service is now in stopped state, no
    // further posts should fire.
    svc._scheduleForTest(path.join(WORKING_DIR, 'b.ts'), 'change');
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTicks();
    expect(postSpy.mock.calls.length).toBe(firstBatch);
  });

  it('retries with backoff on 500 then succeeds', async () => {
    const svc = makeService();
    vi.spyOn(_gitSeam, 'run').mockResolvedValue(SAMPLE_DIFF);
    const postSpy = vi.spyOn(_transport, 'post')
      .mockResolvedValueOnce({ statusCode: 500, body: 'oops' })
      .mockResolvedValueOnce({ statusCode: 200, body: '{}' });

    svc._scheduleForTest(path.join(WORKING_DIR, 'a.ts'), 'change');
    // Debounce (250 ms) + retry backoff on the /files/changed call
    // (300 ms) + slack for the follow-up /review/hunks chain (whose
    // mock is exhausted, so it also burns through MAX_RETRIES + 2
    // backoffs). 3500 ms drains everything so the test doesn't leak
    // a pending Promise into the next test's spy.
    await vi.advanceTimersByTimeAsync(3500);
    await vi.runAllTicks();

    expect(postSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('emits a deletion event for unlinked files when git diff is empty', async () => {
    const svc = makeService();
    // Empty diff is the load-bearing input for this test — exercises
    // the unlink path that still emits a zero-stat deletion so the
    // mobile Files screen drops the row. Non-unlink events with an
    // empty diff are suppressed at source (a no-op touch is not a
    // change worth surfacing).
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

  it('attaches an error handler to chokidar so EPERM does not crash the process (#43)', async () => {
    vi.useRealTimers();

    const handlers: Record<string, ((arg: unknown) => void)[]> = {};
    const mockWatcher = {
      on: vi.fn((event: string, fn: (arg: unknown) => void) => {
        handlers[event] = handlers[event] ?? [];
        handlers[event].push(fn);
        return mockWatcher;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const watchSpy = vi.fn().mockReturnValue(mockWatcher);
    vi.spyOn(_chokidarSeam, 'load').mockReturnValue({ watch: watchSpy });

    const svc = makeService();
    await svc.start();

    expect(handlers.error).toBeDefined();
    expect(handlers.error.length).toBeGreaterThan(0);

    // Simulate the exact crash from #43 — chokidar emitting an EPERM
    // error for a Windows junction. The handler must swallow it.
    const eperm = Object.assign(new Error('EPERM: operation not permitted, watch'), {
      code: 'EPERM',
      path: 'C:\\Users\\Krzysztof\\Application Data',
    });
    expect(() => handlers.error[0](eperm)).not.toThrow();

    await svc.stop();
  });

  it('passes Windows-only chokidar options + ignore patterns when running on win32', async () => {
    vi.useRealTimers();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const watchSpy = vi.fn().mockReturnValue(mockWatcher);
      vi.spyOn(_chokidarSeam, 'load').mockReturnValue({ watch: watchSpy });

      const svc = new FileWatcherService({
        // Use a Windows-shaped project path that is NOT a system / home
        // root so the unsafe-root guard doesn't short-circuit start().
        workingDir: 'C:\\projects\\demo',
        sessionId: 'sess-win',
        pluginId: 'plugin-win',
        pluginAuthToken: 'token-win',
        apiBaseUrl: 'https://api.example.test',
      });
      await svc.start();

      expect(watchSpy).toHaveBeenCalledTimes(1);
      const opts = watchSpy.mock.calls[0][1] as {
        followSymlinks: boolean;
        ignorePermissionErrors: boolean;
        ignored: RegExp[];
      };
      expect(opts.followSymlinks).toBe(false);
      expect(opts.ignorePermissionErrors).toBe(true);
      // The Windows legacy junction list must be in `ignored` so chokidar
      // never tries to descend into Application Data / Cookies / etc.
      const ignoredSources = opts.ignored.map((r) => r.source);
      expect(ignoredSources.some((s) => /Application Data/.test(s))).toBe(true);
      expect(ignoredSources.some((s) => /Cookies/.test(s))).toBe(true);

      await svc.stop();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('refuses to watch the Windows user-profile root', async () => {
    vi.useRealTimers();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      const watchSpy = vi.fn();
      vi.spyOn(_chokidarSeam, 'load').mockReturnValue({ watch: watchSpy });
      // Stub os.homedir indirectly: pass the home value into the
      // workingDir AND match what os.homedir() returns by spying
      // through node's `os` module. Simpler: pass workingDir =
      // os.homedir() on this host — isUnsafeWindowsWatchRoot will
      // detect equality.
      const os = await import('os');
      const svc = new FileWatcherService({
        workingDir: os.homedir(),
        sessionId: 'sess-home',
        pluginId: 'plugin-home',
        pluginAuthToken: 'token-home',
        apiBaseUrl: 'https://api.example.test',
      });
      await svc.start();

      expect(watchSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import {
  _runGitImpl,
  _readUntrackedLineCountImpl,
  collectRepoChangeset,
} from '../../src/services/turn-files/git-changeset';

/**
 * Unit coverage for the once-per-turn changeset collector. The
 * subprocess seam (`_runGitImpl.run`) is stubbed so the spec
 * deterministically pumps porcelain + numstat bytes through the
 * parsers without spawning a real git.
 */
describe('collectRepoChangeset', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('combines status + numstat into one BatchFileEntry array', async () => {
    vi.spyOn(_runGitImpl, 'run').mockImplementation(async (_, args) => {
      if (args.includes('status')) {
        // Two modified files, one added, one deleted, null-separated.
        return [
          ' M src/a.ts',
          ' M src/b.ts',
          '?? src/new.ts',
          ' D src/gone.ts',
        ].join('\0') + '\0';
      }
      if (args.includes('--numstat')) {
        return [
          '3\t1\tsrc/a.ts',
          '0\t5\tsrc/b.ts',
          '12\t0\tsrc/new.ts',
          '0\t10\tsrc/gone.ts',
        ].join('\0') + '\0';
      }
      return '';
    });

    const entries = await collectRepoChangeset({
      repoRoot: '/tmp/fake-repo',
      repoPath: 'codeagent-mobile',
      repoName: 'codeagent-mobile',
    });

    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(4);
    const aTs = entries!.find((e) => e.filePath === 'src/a.ts');
    expect(aTs).toMatchObject({
      filePath: 'src/a.ts',
      fileStatus: 'modified',
      linesAdded: 3,
      linesRemoved: 1,
      hunkCount: 1,
      repoPath: 'codeagent-mobile',
      repoName: 'codeagent-mobile',
    });
    expect(entries!.find((e) => e.filePath === 'src/new.ts')!.fileStatus).toBe('added');
    expect(entries!.find((e) => e.filePath === 'src/gone.ts')!.fileStatus).toBe('deleted');
  });

  it('caps a huge install-leak changeset and skips the per-file line scan', async () => {
    // A dependency/SDK install dumped 600 untracked files into the session dir
    // (the 2026-07-16 gcloud incident). Without a cap the collector would ship
    // all 600 AND read every one to synthesize line counts → memory + a rail
    // flood. It must truncate and skip the reads.
    vi.spyOn(_runGitImpl, 'run').mockImplementation(async (_, args) => {
      if (args.includes('status')) {
        return Array.from({ length: 600 }, (_, i) => `?? pkg/gen_${i}.py`).join('\0') + '\0';
      }
      return ''; // numstat empty → these look untracked
    });
    const readSpy = vi.spyOn(_readUntrackedLineCountImpl, 'read');

    const entries = await collectRepoChangeset({
      repoRoot: '/tmp/fake-repo',
      repoPath: 'r',
      repoName: 'r',
    });

    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(500); // default MAX_CHANGESET_FILES cap
    expect(readSpy).not.toHaveBeenCalled(); // no per-file scan on a truncated changeset
  });

  it('returns null when git status fails (no repo)', async () => {
    vi.spyOn(_runGitImpl, 'run').mockResolvedValue(null);
    const entries = await collectRepoChangeset({
      repoRoot: '/tmp/not-a-repo',
      repoPath: '',
      repoName: 'not-a-repo',
    });
    expect(entries).toBeNull();
  });

  it('degrades to zero stats when numstat fails but status succeeds', async () => {
    vi.spyOn(_runGitImpl, 'run').mockImplementation(async (_, args) => {
      if (args.includes('status')) return ' M src/c.ts\0';
      return null;
    });
    const entries = await collectRepoChangeset({
      repoRoot: '/tmp/r',
      repoPath: '',
      repoName: 'r',
    });
    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({
      filePath: 'src/c.ts',
      linesAdded: 0,
      linesRemoved: 0,
      hunkCount: 0,
    });
  });

  it('treats binary diff markers ("-") as zero-stat rows', async () => {
    vi.spyOn(_runGitImpl, 'run').mockImplementation(async (_, args) => {
      if (args.includes('status')) return ' M assets/logo.png\0';
      if (args.includes('--numstat')) return '-\t-\tassets/logo.png\0';
      return '';
    });
    const entries = await collectRepoChangeset({
      repoRoot: '/tmp/r',
      repoPath: '',
      repoName: 'r',
    });
    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({
      linesAdded: 0,
      linesRemoved: 0,
      hunkCount: 0,
    });
  });

  // ── Untracked-file line-count synthesis ────────────────────────────
  //
  // When a file appears as `??` in `git status --porcelain` it is
  // absent from `git diff --numstat HEAD` (git doesn't track it yet).
  // The changeset collector must synthesise the line count by reading
  // the file so the mobile/web review shows the real added-line count
  // instead of "+0 −0".

  it('untracked new file: reads line count from file when absent from numstat', async () => {
    // git status reports an untracked file; numstat has nothing for it
    // (as would happen in production when git diff --numstat HEAD only
    // covers tracked changes).
    vi.spyOn(_runGitImpl, 'run').mockImplementation(async (_, args) => {
      if (args.includes('status')) return '?? src/new-feature.ts\0';
      if (args.includes('--numstat')) return ''; // empty — no tracked changes
      return '';
    });
    // Stub the file-read seam to return a 10-line file.
    vi.spyOn(_readUntrackedLineCountImpl, 'read').mockResolvedValue(10);

    const entries = await collectRepoChangeset({
      repoRoot: '/tmp/fake-repo',
      repoPath: 'myrepo',
      repoName: 'myrepo',
    });

    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({
      filePath: 'src/new-feature.ts',
      fileStatus: 'added',
      linesAdded: 10,
      linesRemoved: 0,
      hunkCount: 1,
      repoPath: 'myrepo',
      repoName: 'myrepo',
    });
    // Confirm we asked to read the right absolute path. Build the
    // expected path with `path.join` so the assertion matches the
    // production code's join (which uses the platform separator —
    // backslashes on Windows CI, forward slashes elsewhere).
    expect(_readUntrackedLineCountImpl.read).toHaveBeenCalledWith(
      path.join('/tmp/fake-repo', 'src/new-feature.ts'),
    );
  });

  it('staged new file (A in index) uses numstat, not file read', async () => {
    // A staged new file has index code `A ` — it IS in numstat because
    // `git diff --numstat HEAD` covers the index-vs-HEAD delta.
    vi.spyOn(_runGitImpl, 'run').mockImplementation(async (_, args) => {
      if (args.includes('status')) return 'A  src/staged-new.ts\0';
      if (args.includes('--numstat')) return '7\t0\tsrc/staged-new.ts\0';
      return '';
    });
    const readSpy = vi.spyOn(_readUntrackedLineCountImpl, 'read');

    const entries = await collectRepoChangeset({
      repoRoot: '/tmp/r',
      repoPath: '',
      repoName: 'r',
    });

    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({
      filePath: 'src/staged-new.ts',
      fileStatus: 'added',
      linesAdded: 7,
      linesRemoved: 0,
      hunkCount: 1,
    });
    // File-read seam must NOT be called — numstat supplied the count.
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('untracked binary/unreadable file degrades to linesAdded=0, hunkCount=0', async () => {
    vi.spyOn(_runGitImpl, 'run').mockImplementation(async (_, args) => {
      if (args.includes('status')) return '?? assets/image.bin\0';
      if (args.includes('--numstat')) return '';
      return '';
    });
    // Simulate a binary file that cannot be decoded as UTF-8 by
    // returning 0 from the read seam (same as the real implementation
    // does on a readFile error).
    vi.spyOn(_readUntrackedLineCountImpl, 'read').mockResolvedValue(0);

    const entries = await collectRepoChangeset({
      repoRoot: '/tmp/r',
      repoPath: '',
      repoName: 'r',
    });

    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({
      filePath: 'assets/image.bin',
      fileStatus: 'added',
      linesAdded: 0,
      linesRemoved: 0,
      hunkCount: 0,
    });
  });

  it('gitignored paths are excluded by git status and never reach the collector', async () => {
    // git status --porcelain already respects .gitignore; ignored files
    // never appear in its output. The collector asserts this contract by
    // relying entirely on git's output — it does NOT add ignored paths
    // back. This test confirms that a status output that omits
    // node_modules (as git would) produces no node_modules entries.
    vi.spyOn(_runGitImpl, 'run').mockImplementation(async (_, args) => {
      if (args.includes('status')) {
        // Only the user file is reported — node_modules is gitignored
        // and therefore absent from `git status --porcelain` output.
        return '?? src/user-file.ts\0';
      }
      if (args.includes('--numstat')) return '';
      return '';
    });
    vi.spyOn(_readUntrackedLineCountImpl, 'read').mockResolvedValue(5);

    const entries = await collectRepoChangeset({
      repoRoot: '/tmp/r',
      repoPath: '',
      repoName: 'r',
    });

    // node_modules should be absent — git excluded it before we ever
    // see the status output.
    const paths = entries!.map((e) => e.filePath);
    expect(paths).not.toContain('node_modules/some-pkg/index.js');
    expect(paths).toContain('src/user-file.ts');
  });

  it('does not double-count a file that appears in both status and numstat', async () => {
    // A modified+staged tracked file appears in both `git status` and
    // `git diff --numstat HEAD`. The collector must not produce two
    // entries — it iterates status rows and looks up numstat by path,
    // so each path appears exactly once.
    vi.spyOn(_runGitImpl, 'run').mockImplementation(async (_, args) => {
      if (args.includes('status')) return ' M src/shared.ts\0';
      if (args.includes('--numstat')) return '4\t2\tsrc/shared.ts\0';
      return '';
    });
    const readSpy = vi.spyOn(_readUntrackedLineCountImpl, 'read');

    const entries = await collectRepoChangeset({
      repoRoot: '/tmp/r',
      repoPath: '',
      repoName: 'r',
    });

    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({
      filePath: 'src/shared.ts',
      fileStatus: 'modified',
      linesAdded: 4,
      linesRemoved: 2,
    });
    // modified files are not 'added', so the file-read path is skipped.
    expect(readSpy).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  _runGitImpl,
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
});

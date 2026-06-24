import { describe, it, expect, vi, afterEach } from 'vitest';

import * as gitBranch from '../src/lib/git-branch';

describe('detectCurrentBranch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the trimmed branch name on a normal branch', () => {
    vi.spyOn(gitBranch._execSeam, 'exec').mockReturnValue('feat/cli-git-branch-on-pair\n');
    expect(gitBranch.detectCurrentBranch()).toBe('feat/cli-git-branch-on-pair');
  });

  it('returns null on detached HEAD (empty stdout)', () => {
    // `git branch --show-current` prints nothing in detached-HEAD state.
    vi.spyOn(gitBranch._execSeam, 'exec').mockReturnValue('\n');
    expect(gitBranch.detectCurrentBranch()).toBeNull();
  });

  it('returns null when cwd is not a git repository', () => {
    // `git` exits non-zero outside a repo → execSync throws.
    vi.spyOn(gitBranch._execSeam, 'exec').mockImplementation(() => {
      throw new Error("fatal: not a git repository (or any of the parent directories): .git");
    });
    expect(gitBranch.detectCurrentBranch()).toBeNull();
  });

  it('returns null when git is unavailable (ENOENT)', () => {
    vi.spyOn(gitBranch._execSeam, 'exec').mockImplementation(() => {
      const err = new Error('spawn git ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(gitBranch.detectCurrentBranch()).toBeNull();
  });

  it('uses the provided cwd when given', () => {
    const spy = vi
      .spyOn(gitBranch._execSeam, 'exec')
      .mockReturnValue('main\n');
    gitBranch.detectCurrentBranch('/some/other/dir');
    expect(spy).toHaveBeenCalledTimes(1);
    // Signature is (file, args, opts) — file is 'git', args is fixed.
    const [file, args, opts] = spy.mock.calls[0];
    expect(file).toBe('git');
    expect(args).toEqual(['branch', '--show-current']);
    const cwd = (opts as { cwd?: string }).cwd;
    expect(cwd).toBe('/some/other/dir');
  });

  it('handles trailing whitespace and CRLF', () => {
    vi.spyOn(gitBranch._execSeam, 'exec').mockReturnValue('  develop  \r\n');
    expect(gitBranch.detectCurrentBranch()).toBe('develop');
  });
});

describe('detectCurrentBranchAsync — non-blocking branch detection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the trimmed branch name on a normal branch', async () => {
    vi.spyOn(gitBranch._execSeamAsync, 'exec').mockResolvedValue('feat/headroom\n');
    await expect(gitBranch.detectCurrentBranchAsync()).resolves.toBe('feat/headroom');
  });

  it('returns null on detached HEAD (empty stdout)', async () => {
    vi.spyOn(gitBranch._execSeamAsync, 'exec').mockResolvedValue('\n');
    await expect(gitBranch.detectCurrentBranchAsync()).resolves.toBeNull();
  });

  it('returns null (never rejects) when git fails / is unavailable', async () => {
    vi.spyOn(gitBranch._execSeamAsync, 'exec').mockRejectedValue(new Error('spawn git ENOENT'));
    await expect(gitBranch.detectCurrentBranchAsync()).resolves.toBeNull();
  });

  it('uses the provided cwd and the fixed argv', async () => {
    const spy = vi.spyOn(gitBranch._execSeamAsync, 'exec').mockResolvedValue('main\n');
    await gitBranch.detectCurrentBranchAsync('/some/other/dir');
    expect(spy).toHaveBeenCalledTimes(1);
    const [file, args, opts] = spy.mock.calls[0];
    expect(file).toBe('git');
    expect(args).toEqual(['branch', '--show-current']);
    expect((opts as { cwd?: string }).cwd).toBe('/some/other/dir');
  });
});

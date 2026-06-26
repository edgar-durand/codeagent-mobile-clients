import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('vscode', () => ({}));

afterEach(() => vi.restoreAllMocks());

describe('ProjectOpsService.detectRepoSlug', () => {
  async function withRemote(url: string, code = 0) {
    const mod = await import('../project-ops.service');
    vi.spyOn(mod.ProjectOpsService as unknown as { git: (a: string[]) => Promise<unknown> }, 'git')
      .mockResolvedValue({ stdout: url ? `${url}\n` : '', stderr: '', code });
    return mod.ProjectOpsService.detectRepoSlug();
  }

  it('parses an https GitHub remote', async () => {
    expect(await withRemote('https://github.com/edgar-durand/personal-driver-landing.git'))
      .toEqual({ owner: 'edgar-durand', repo: 'personal-driver-landing' });
  });
  it('parses an ssh GitHub remote', async () => {
    expect(await withRemote('git@github.com:edgar-durand/my-repo.git'))
      .toEqual({ owner: 'edgar-durand', repo: 'my-repo' });
  });
  it('returns null for a non-GitHub remote', async () => {
    expect(await withRemote('https://gitlab.com/foo/bar.git')).toBeNull();
  });
  it('returns null when git has no origin remote', async () => {
    expect(await withRemote('', 1)).toBeNull();
  });
});

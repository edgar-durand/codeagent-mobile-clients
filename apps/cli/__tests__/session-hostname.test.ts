import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import * as sessionHostname from '../src/lib/session-hostname';
import {
  normalizeRepoIdentifier,
  resolveSessionHostname,
  _execSeam,
  _osSeam,
} from '../src/lib/session-hostname';

const ORIGINAL_CODESPACES = process.env.CODESPACES;

beforeEach(() => {
  sessionHostname._resetSessionHostnameCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_CODESPACES === undefined) delete process.env.CODESPACES;
  else process.env.CODESPACES = ORIGINAL_CODESPACES;
});

describe('normalizeRepoIdentifier', () => {
  it('parses an https remote', () => {
    expect(normalizeRepoIdentifier('https://github.com/acme/widgets.git\n')).toBe('acme/widgets');
  });

  it('parses an https remote without the .git suffix', () => {
    expect(normalizeRepoIdentifier('https://github.com/acme/widgets')).toBe('acme/widgets');
  });

  it('parses an scp-style ssh remote', () => {
    expect(normalizeRepoIdentifier('git@github.com:acme/widgets.git')).toBe('acme/widgets');
  });

  it('parses an ssh:// remote', () => {
    expect(normalizeRepoIdentifier('ssh://git@github.com/acme/widgets.git')).toBe('acme/widgets');
  });

  it('handles a trailing slash', () => {
    expect(normalizeRepoIdentifier('https://github.com/acme/widgets/')).toBe('acme/widgets');
  });

  it('SEC: strips embedded credentials so a clone token never leaks into the label', () => {
    const out = normalizeRepoIdentifier(
      'https://x-access-token:ghs_SUPERSECRETTOKEN@github.com/acme/widgets.git',
    );
    expect(out).toBe('acme/widgets');
    expect(out).not.toMatch(/ghs_|x-access-token/);
  });

  it('returns null for empty / unparseable input', () => {
    expect(normalizeRepoIdentifier('')).toBeNull();
    expect(normalizeRepoIdentifier('   \n')).toBeNull();
    expect(normalizeRepoIdentifier('https://github.com/onlyowner')).toBeNull();
  });
});

describe('resolveSessionHostname — outside a codespace', () => {
  it('reports the machine hostname unchanged and never spawns git', () => {
    delete process.env.CODESPACES;
    vi.spyOn(_osSeam, 'hostname').mockReturnValue('edgars-macbook');
    const git = vi.spyOn(_execSeam, 'exec').mockReturnValue('https://github.com/acme/widgets.git');

    expect(resolveSessionHostname('/Users/edgar/dev/widgets')).toBe('edgars-macbook');
    expect(git).not.toHaveBeenCalled();
  });

  it('reports the machine hostname when CODESPACES is set to something other than "true"', () => {
    process.env.CODESPACES = 'false';
    vi.spyOn(_osSeam, 'hostname').mockReturnValue('self-hosted-box');
    expect(resolveSessionHostname('/home/box/project')).toBe('self-hosted-box');
  });
});

describe('resolveSessionHostname — inside a codespace', () => {
  beforeEach(() => {
    process.env.CODESPACES = 'true';
    // Every wrapper-repo codespace reports this same shared hostname.
    vi.spyOn(_osSeam, 'hostname').mockReturnValue('codespaces-496218');
  });

  it('reports the user repo as owner/repo from the git remote', () => {
    vi.spyOn(_execSeam, 'exec').mockReturnValue('https://github.com/acme/widgets.git\n');
    expect(resolveSessionHostname('/workspaces/widgets')).toBe('acme/widgets');
  });

  it('gives two codespaces on different repos DIFFERENT labels', () => {
    const git = vi.spyOn(_execSeam, 'exec');
    git.mockReturnValue('https://github.com/acme/widgets.git');
    const a = resolveSessionHostname('/workspaces/widgets');
    sessionHostname._resetSessionHostnameCache();
    git.mockReturnValue('https://github.com/other/notes.git');
    const b = resolveSessionHostname('/workspaces/notes');

    expect(a).toBe('acme/widgets');
    expect(b).toBe('other/notes');
    expect(a).not.toBe(b);
  });

  it('falls back to the checkout directory name when the repo has no remote', () => {
    vi.spyOn(_execSeam, 'exec').mockImplementation(() => {
      throw new Error("error: No such remote 'origin'");
    });
    expect(resolveSessionHostname('/workspaces/my-project')).toBe('my-project');
  });

  it('never labels a session with the wrapper repo checkout', () => {
    vi.spyOn(_execSeam, 'exec').mockImplementation(() => {
      throw new Error('no remote');
    });
    // If the daemon somehow runs from the wrapper checkout we must NOT
    // surface "codeam-codespace" as the user's session name.
    expect(resolveSessionHostname('/workspaces/codeam-codespace')).toBe('codespaces-496218');
  });

  it('falls back to the hostname when git is unavailable and cwd is /workspaces', () => {
    vi.spyOn(_execSeam, 'exec').mockImplementation(() => {
      const err = new Error('spawn git ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(resolveSessionHostname('/workspaces')).toBe('codespaces-496218');
  });

  it('runs git at most once per process even across repeated pairing attempts', () => {
    const git = vi.spyOn(_execSeam, 'exec').mockReturnValue('https://github.com/acme/widgets.git');
    resolveSessionHostname('/workspaces/widgets');
    resolveSessionHostname('/workspaces/widgets');
    resolveSessionHostname('/workspaces/widgets');
    expect(git).toHaveBeenCalledTimes(1);
  });

  it('passes the cwd through to git and never uses a shell', () => {
    const git = vi.spyOn(_execSeam, 'exec').mockReturnValue('https://github.com/acme/widgets.git');
    resolveSessionHostname('/workspaces/widgets');
    const [file, args, opts] = git.mock.calls[0];
    expect(file).toBe('git');
    expect(args).toEqual(['remote', 'get-url', 'origin']);
    expect((opts as { cwd?: string }).cwd).toBe('/workspaces/widgets');
  });

  it('SEC: a remote URL carrying a clone token never reaches the reported label', () => {
    vi.spyOn(_execSeam, 'exec').mockReturnValue(
      'https://x-access-token:ghs_LEAKME@github.com/acme/widgets.git\n',
    );
    const label = resolveSessionHostname('/workspaces/widgets');
    expect(label).toBe('acme/widgets');
    expect(label).not.toContain('ghs_LEAKME');
  });
});

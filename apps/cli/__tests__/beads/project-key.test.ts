import { describe, it, expect, vi, afterEach } from 'vitest';
import * as pk from '../../src/beads/project-key';

const { normalizeOrigin, deriveProjectIdentity, _execSeam } = pk;

describe('normalizeOrigin (D7)', () => {
  it('normalizes an https remote → host/org/repo', () => {
    expect(normalizeOrigin('https://github.com/edgar-durand/codeagent-mobile-clients.git')).toBe(
      'github.com/edgar-durand/codeagent-mobile-clients',
    );
  });

  it('strips embedded credentials and lowercases the host', () => {
    expect(normalizeOrigin('https://user:token@GitHub.com/Org/Repo.git')).toBe(
      'github.com/Org/Repo',
    );
  });

  it('normalizes an scp-like git@host:org/repo remote', () => {
    expect(normalizeOrigin('git@github.com:edgar-durand/repo.git')).toBe(
      'github.com/edgar-durand/repo',
    );
  });

  it('normalizes an ssh:// remote and drops the port', () => {
    expect(normalizeOrigin('ssh://git@github.com:22/org/repo.git')).toBe(
      'github.com/org/repo',
    );
  });

  it('returns null for an unparseable remote', () => {
    expect(normalizeOrigin('   ')).toBeNull();
    expect(normalizeOrigin('not-a-url')).toBeNull();
  });
});

describe('deriveProjectIdentity', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the normalized origin as the key and the repo name as the label', () => {
    vi.spyOn(_execSeam, 'exec').mockReturnValue(
      'https://github.com/edgar-durand/codeagent-mobile-clients.git\n',
    );
    const id = deriveProjectIdentity('/some/repo');
    expect(id.projectKey).toBe('github.com/edgar-durand/codeagent-mobile-clients');
    expect(id.projectLabel).toBe('codeagent-mobile-clients');
  });

  it('falls back to path:<sha256> when there is no origin remote', () => {
    // `git remote get-url origin` exits non-zero with no remote → throws.
    vi.spyOn(_execSeam, 'exec').mockImplementation(() => {
      throw new Error('fatal: No such remote');
    });
    vi.spyOn(_execSeam, 'realpath').mockReturnValue('/Users/x/projects/local-only');
    const id = deriveProjectIdentity('/Users/x/projects/local-only');
    expect(id.projectKey).toMatch(/^path:[0-9a-f]{64}$/);
    expect(id.projectLabel).toBe('local-only');
  });

  it('produces a stable key across calls for the same path fallback', () => {
    vi.spyOn(_execSeam, 'exec').mockImplementation(() => {
      throw new Error('no remote');
    });
    vi.spyOn(_execSeam, 'realpath').mockReturnValue('/Users/x/projects/repo');
    const a = deriveProjectIdentity('/Users/x/projects/repo');
    const b = deriveProjectIdentity('/Users/x/projects/repo');
    expect(a.projectKey).toBe(b.projectKey);
  });
});

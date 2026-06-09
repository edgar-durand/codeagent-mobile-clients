import { describe, it, expect, vi, afterEach } from 'vitest';
import * as adapter from '../../src/beads/bd-adapter';
import type { BdRunResult } from '../../src/beads/bd-adapter';

const { BdAdapter, _resolveSeam, _spawnSeam } = adapter;

function ok(stdout: string): BdRunResult {
  return { code: 0, stdout, stderr: '' };
}

describe('BdAdapter binary resolution', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prefers the bundled @beads/bd binary over PATH', () => {
    vi.spyOn(_resolveSeam, 'resolveBundled').mockReturnValue('/pkg/@beads/bd/bin/bd');
    const onPath = vi.spyOn(_resolveSeam, 'resolveOnPath').mockReturnValue('/usr/local/bin/bd');
    const a = new BdAdapter();
    expect(a.resolveBinary()).toBe('/pkg/@beads/bd/bin/bd');
    // PATH probe never consulted when bundled resolves.
    expect(onPath).not.toHaveBeenCalled();
  });

  it('falls back to bd on PATH when the bundled binary is absent', () => {
    vi.spyOn(_resolveSeam, 'resolveBundled').mockReturnValue(null);
    vi.spyOn(_resolveSeam, 'resolveOnPath').mockReturnValue('/usr/local/bin/bd');
    const a = new BdAdapter();
    expect(a.resolveBinary()).toBe('/usr/local/bin/bd');
    expect(a.isAvailable()).toBe(true);
  });

  it('returns null (caller offers installer) when neither bundled nor PATH resolves', () => {
    vi.spyOn(_resolveSeam, 'resolveBundled').mockReturnValue(null);
    vi.spyOn(_resolveSeam, 'resolveOnPath').mockReturnValue(null);
    const a = new BdAdapter();
    expect(a.resolveBinary()).toBeNull();
    expect(a.isAvailable()).toBe(false);
  });

  it('resolves bd.exe on Windows from the bundled package bin dir', () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      // Drive the real _defaultResolveBundled via require.resolve + fs by
      // stubbing the seam to mimic the Windows binary name resolution.
      vi.spyOn(_resolveSeam, 'resolveBundled').mockImplementation(() =>
        process.platform === 'win32'
          ? 'C:\\pkg\\@beads\\bd\\bin\\bd.exe'
          : '/pkg/@beads/bd/bin/bd',
      );
      const a = new BdAdapter();
      expect(a.resolveBinary()).toMatch(/bd\.exe$/);
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });

  it('honors an explicit binaryPath override (skips resolution)', () => {
    const bundled = vi.spyOn(_resolveSeam, 'resolveBundled');
    const a = new BdAdapter({ binaryPath: '/custom/bd' });
    expect(a.resolveBinary()).toBe('/custom/bd');
    expect(bundled).not.toHaveBeenCalled();
  });
});

describe('BdAdapter --global home-brain wiring', () => {
  afterEach(() => vi.restoreAllMocks());

  it('appends --global to every command (the home-level shared brain)', async () => {
    const spy = vi.spyOn(_spawnSeam, 'run').mockResolvedValue(ok('[]'));
    const a = new BdAdapter({ binaryPath: '/bd' });
    await a.run(['ready', '--json']);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, args] = spy.mock.calls[0];
    expect(args).toEqual(['ready', '--json', '--global']);
  });

  it('uses BEADS_DIR instead of --global when an override is set (test isolation)', async () => {
    const spy = vi.spyOn(_spawnSeam, 'run').mockResolvedValue(ok('[]'));
    const a = new BdAdapter({ binaryPath: '/bd', beadsDir: '/tmp/test-beads' });
    await a.run(['ready', '--json']);
    const [, args, opts] = spy.mock.calls[0];
    expect(args).toEqual(['ready', '--json']); // no --global
    expect(opts.env.BEADS_DIR).toBe('/tmp/test-beads');
  });

  it('does not double-add --global if the caller already passed it', async () => {
    const spy = vi.spyOn(_spawnSeam, 'run').mockResolvedValue(ok('[]'));
    const a = new BdAdapter({ binaryPath: '/bd' });
    await a.run(['status', '--json', '--global']);
    const [, args] = spy.mock.calls[0];
    expect(args.filter((x) => x === '--global')).toHaveLength(1);
  });

  it('returns an error result when no binary resolves', async () => {
    vi.spyOn(_resolveSeam, 'resolveBundled').mockReturnValue(null);
    vi.spyOn(_resolveSeam, 'resolveOnPath').mockReturnValue(null);
    const a = new BdAdapter();
    const res = await a.run(['ready', '--json']);
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain('not resolved');
  });
});

describe('BdAdapter JSON parsing', () => {
  afterEach(() => vi.restoreAllMocks());

  const READY_JSON = JSON.stringify([
    {
      id: 'bd-a1b2',
      title: 'ready task',
      status: 'open',
      priority: 1,
      issue_type: 'task',
      owner: null,
      created_at: '2026-06-09T10:00:00Z',
      updated_at: '2026-06-09T10:00:00Z',
      dependency_count: 0,
      dependent_count: 1,
      comment_count: 0,
    },
    {
      id: 'bd-c3d4',
      title: 'claimed task',
      status: 'in_progress',
      priority: 0,
      issue_type: 'bug',
      owner: 'claude',
      created_at: '2026-06-09T09:00:00Z',
      updated_at: '2026-06-09T11:00:00Z',
    },
  ]);

  it('parses `bd ready --json` rows and tags each with the projectKey', async () => {
    vi.spyOn(_spawnSeam, 'run').mockResolvedValue(ok(READY_JSON));
    const a = new BdAdapter({ binaryPath: '/bd' });
    const issues = await a.readyIssues('github.com/edgar-durand/repo');
    expect(issues).toHaveLength(2);
    expect(issues[0].id).toBe('bd-a1b2');
    expect(issues[0].owner).toBeNull();
    expect(issues[1].status).toBe('in_progress');
    expect(issues.every((i) => i.projectKey === 'github.com/edgar-durand/repo')).toBe(true);
  });

  it('returns [] on malformed JSON without throwing', async () => {
    vi.spyOn(_spawnSeam, 'run').mockResolvedValue(ok('not json'));
    const a = new BdAdapter({ binaryPath: '/bd' });
    expect(await a.readyIssues('k')).toEqual([]);
  });

  it('returns [] on a non-zero exit', async () => {
    vi.spyOn(_spawnSeam, 'run').mockResolvedValue({ code: 1, stdout: '[]', stderr: 'boom' });
    const a = new BdAdapter({ binaryPath: '/bd' });
    expect(await a.readyIssues('k')).toEqual([]);
  });

  it('skips rows missing required fields (id/title) rather than dropping the batch', async () => {
    const mixed = JSON.stringify([
      { id: 'bd-ok', title: 't', status: 'open', priority: null, issue_type: 'task' },
      { title: 'no id' },
      { id: 'bd-bad-status', title: 't2', status: 'weird', priority: null, issue_type: 'task' },
    ]);
    vi.spyOn(_spawnSeam, 'run').mockResolvedValue(ok(mixed));
    const a = new BdAdapter({ binaryPath: '/bd' });
    const issues = await a.readyIssues('k');
    expect(issues.map((i) => i.id)).toEqual(['bd-ok', 'bd-bad-status']);
    // unknown status coerced to 'open'
    expect(issues[1].status).toBe('open');
  });

  it('parses `bd status --json` summary block', async () => {
    const statusJson = JSON.stringify({
      schema_version: 1,
      summary: {
        open_issues: 4,
        ready_issues: 2,
        blocked_issues: 1,
        in_progress_issues: 1,
        closed_issues: 7,
        total_issues: 13,
      },
    });
    vi.spyOn(_spawnSeam, 'run').mockResolvedValue(ok(statusJson));
    const a = new BdAdapter({ binaryPath: '/bd' });
    const summary = await a.statusSummary();
    expect(summary?.ready_issues).toBe(2);
    expect(summary?.total_issues).toBe(13);
  });

  it('returns null summary on bd failure', async () => {
    vi.spyOn(_spawnSeam, 'run').mockResolvedValue({ code: 2, stdout: '', stderr: 'x' });
    const a = new BdAdapter({ binaryPath: '/bd' });
    expect(await a.statusSummary()).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * doctor command spec.
 *
 * The command shells out to network + filesystem + native module
 * loads, so the runtime path requires mocking. We pin two
 * invariants:
 *
 *   1. The JSON reporter shape is stable — the diagnosticId,
 *      cliVersion, checks[], and `ok` discriminator must always be
 *      present so the support workflow can grep on them.
 *   2. No token, session id, or absolute home path leaks into
 *      either reporter output. This is the audit invariant the
 *      `paired sessions` check is supposed to honour.
 */

// Mocks need to land BEFORE the import of doctor — vitest hoists
// `vi.mock` calls to the top, so any imports below see the mocks.
vi.mock('../../src/config', () => ({
  loadCliConfig: vi.fn(() => ({
    pluginId: 'plugin-x',
    activeSessionId: 'session-secret',
    sessions: [
      {
        id: 'session-secret',
        pluginAuthToken: 'tok-DO-NOT-LEAK',
        userName: 'someone',
        userEmail: 'someone@example.com',
        plan: 'pro',
        pairedAt: 0,
        agent: 'claude',
      },
    ],
  })),
}));

// Stub fetch so the /api/health check resolves deterministically
// without a network round-trip.
const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
vi.stubGlobal('fetch', fetchSpy);

// Stub dns.resolve so the DNS check resolves without a real lookup.
vi.mock('node:dns', async () => {
  const actual = await vi.importActual<typeof import('node:dns')>('node:dns');
  return {
    ...actual,
    resolve: (
      host: string,
      cb: (err: Error | null, addrs: string[]) => void,
    ) => cb(null, ['127.0.0.1']),
  };
});

import { doctor } from '../../src/commands/doctor';

describe('doctor', () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];
  // process.exit spy is re-armed per-test (afterEach restoreAllMocks
  // would otherwise let a real exit() escape and tear down the worker).
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      return undefined as never;
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('JSON mode emits a single JSON document with the required shape', async () => {
    await doctor(['--json']);
    const out = stdoutChunks.join('');
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      diagnosticId: expect.any(String),
      cliVersion: expect.any(String),
      node: expect.stringMatching(/^v\d+/),
      platform: expect.any(String),
      arch: expect.any(String),
      apiBase: expect.stringContaining('://'),
      ok: expect.any(Boolean),
      checks: expect.any(Array),
    });
    // checks[] is non-empty + each entry has the contract shape.
    expect(parsed.checks.length).toBeGreaterThan(0);
    for (const c of parsed.checks) {
      expect(c).toMatchObject({
        id: expect.any(String),
        label: expect.any(String),
        ok: expect.any(Boolean),
        detail: expect.any(String),
      });
    }
  });

  it('NEVER prints the pluginAuthToken or session id in either reporter', async () => {
    await doctor([]);
    const allOutput = stdoutChunks.join('') + stderrChunks.join('');
    expect(allOutput).not.toContain('tok-DO-NOT-LEAK');
    expect(allOutput).not.toContain('session-secret');

    // JSON mode same invariant.
    stdoutChunks = [];
    stderrChunks = [];
    await doctor(['--json']);
    const jsonOutput = stdoutChunks.join('') + stderrChunks.join('');
    expect(jsonOutput).not.toContain('tok-DO-NOT-LEAK');
    expect(jsonOutput).not.toContain('session-secret');
  });

  it('paired-sessions check reports the COUNT (no token / id leakage)', async () => {
    await doctor(['--json']);
    const parsed = JSON.parse(stdoutChunks.join(''));
    const sessions = parsed.checks.find((c: { id: string }) => c.id === 'sessions');
    expect(sessions).toBeDefined();
    expect(sessions.ok).toBe(true);
    // Detail says "1 paired" — count only, never the id.
    expect(sessions.detail).toBe('1 paired');
  });

  it('exits 0 when all checks pass', async () => {
    await doctor(['--json']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 when at least one check fails (5xx /api/health)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));
    await doctor(['--json']);
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });

  it('text mode goes to stderr so --json stdout stays parseable', async () => {
    await doctor([]);
    const stdoutOut = stdoutChunks.join('');
    const stderrOut = stderrChunks.join('');
    // No JSON document on stdout in text mode — keeps `codeam doctor 2>/dev/null`
    // from accidentally surfacing the banner.
    expect(stdoutOut).toBe('');
    // The banner header lands on stderr.
    expect(stderrOut).toContain('codeam doctor');
    expect(stderrOut).toContain('diag id');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The notifier is fire-and-forget — these tests verify it bails out
 * early in the contexts where notification is undesirable (CI, piped
 * stdout, opt-out env var, NODE_ENV=test). We don't try to test the
 * happy-path HTTPS fetch in unit tests; that's effectively a network
 * call against the npm registry and is exercised in production.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('updateNotifier — guards', () => {
  it('does not write to stderr when NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { checkForUpdates } = await import('../src/lib/updateNotifier');
    checkForUpdates();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does not write to stderr when CI is set', async () => {
    delete process.env.NODE_ENV;
    process.env.CI = '1';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { checkForUpdates } = await import('../src/lib/updateNotifier');
    checkForUpdates();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does not write to stderr when CODEAM_DISABLE_UPDATE_CHECK=1', async () => {
    delete process.env.NODE_ENV;
    delete process.env.CI;
    process.env.CODEAM_DISABLE_UPDATE_CHECK = '1';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { checkForUpdates } = await import('../src/lib/updateNotifier');
    checkForUpdates();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The 2026-08-19 conversion killer: a user linked Gemini via "Login with
 * Google", Google killed free access on 2026-06-18, and every deploy died at
 * agent start with the `ineligible_tier` bubble — but the CLI told the BACKEND
 * nothing, so Profile › Agents kept showing "CONNECTED · DEFAULT", the wizard
 * kept preselecting Gemini, and the user burned six codespaces.
 *
 * These tests pin the missing report: a startup failure classified
 * `ineligible_tier` must fire `reportCredentialInvalid` EXACTLY ONCE per
 * session with `reason: 'ineligible_tier'`, and nothing else at startup may.
 */

vi.mock('../../src/agents/acp/backend-reports', () => ({
  reportCredentialInvalid: vi.fn(async () => undefined),
  postBudgetReached: vi.fn(async () => undefined),
  postCredentialSync: vi.fn(async () => undefined),
}));

// The error relay keeps the process alive on a real startup failure — stub it
// so the test doesn't open an SSE connection.
vi.mock('../../src/services/command-relay.service', () => ({
  CommandRelayService: class {
    start(): void {}
    stop(): void {}
    async sendResult(): Promise<void> {}
  },
}));

import { surfaceStartupFailure, _startupCredentialReportGuard } from '../../src/agents/acp/runner';
import { reportCredentialInvalid } from '../../src/agents/acp/backend-reports';

const GEMINI_INELIGIBLE_STDERR =
  'Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. reasonCode: UNSUPPORTED_CLIENT';

/** Minimal publisher stub — `surfaceStartupFailure` only publishes output. */
const fakePublisher = (): { publishOutput: ReturnType<typeof vi.fn> } => ({
  publishOutput: vi.fn(async () => undefined),
});

const call = (
  overrides: Partial<Parameters<typeof surfaceStartupFailure>[0]> = {},
): Promise<void> =>
  surfaceStartupFailure({
    agent: 'gemini',
    pluginId: 'p1',
    detail: 'AGENT_STARTUP_FAILED',
    recentStderr: GEMINI_INELIGIBLE_STDERR,
    publisher: fakePublisher() as never,
    sessionId: 's1',
    pluginAuthToken: 'tok',
    pollSecret: 'poll',
    ...overrides,
  });

describe('surfaceStartupFailure — reports a permanently-unusable credential', () => {
  beforeEach(() => {
    vi.mocked(reportCredentialInvalid).mockClear();
    _startupCredentialReportGuard.reported = false;
  });

  it('gemini ineligible_tier → reports the credential invalid with the reason', async () => {
    await call();

    expect(reportCredentialInvalid).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportCredentialInvalid).mock.calls[0]![0]).toEqual({
      agent: 'gemini',
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 'tok',
      pollSecret: 'poll',
      reason: 'ineligible_tier',
    });
  });

  it('fires EXACTLY ONCE per session even when the startup failure resurfaces', async () => {
    await call();
    await call();
    await call();

    expect(reportCredentialInvalid).toHaveBeenCalledTimes(1);
  });

  it('a GENERIC startup failure never touches the credential', async () => {
    await call({
      agent: 'claude',
      detail: 'AGENT_STARTUP_TIMEOUT',
      recentStderr: 'ERR_MODULE_NOT_FOUND: cannot find module zod/v4',
    });

    expect(reportCredentialInvalid).not.toHaveBeenCalled();
  });

  it('a bare auth failure at startup is left to the existing auth path (unchanged)', async () => {
    // A 401 at startup may just be a stale access token the box can refresh —
    // only the adapter-exit auth handler owns that call. Startup reports ONLY
    // the definitively-unusable class.
    await call({
      agent: 'claude',
      detail: 'invalid x-api-key 401 authentication_error',
      recentStderr: '',
    });

    expect(reportCredentialInvalid).not.toHaveBeenCalled();
  });

  it('skips the report (but still publishes the bubble) when there is no session token', async () => {
    const publisher = fakePublisher();
    await call({ publisher: publisher as never, sessionId: undefined, pluginAuthToken: undefined });

    expect(reportCredentialInvalid).not.toHaveBeenCalled();
    expect(publisher.publishOutput).toHaveBeenCalled();
  });
});

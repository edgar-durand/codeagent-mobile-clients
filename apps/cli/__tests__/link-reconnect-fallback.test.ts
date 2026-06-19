/**
 * Tests for the `codeam link` PoP-enforcement fallback:
 *
 * Under the backend's poll-secret (PoP) enforcement the `pair_completed`
 * broadcast intentionally omits `pluginAuthToken` (broadcasting it on the
 * pluginId-gated pending-stream is a vuln). When that happens `link.ts`
 * must fetch the token via `fetchCurrentPluginAuthToken` (which POSTs to
 * /api/pairing/reconnect with X-Plugin-Poll-Secret) before proceeding.
 *
 * These tests verify:
 *   1. When `paired.pluginAuthToken` is absent but reconnect succeeds →
 *      the token is resolved and the flow continues (no error exit).
 *   2. When both are absent → a clear error is shown and process.exit(1)
 *      is called.
 *   3. When `paired.pluginAuthToken` is present → reconnect is not called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Stable module mocks ──────────────────────────────────────────────────────

vi.mock('../src/ui/banner', () => ({
  showIntro: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showInfo: vi.fn(),
  showPairingCode: vi.fn(),
  formatRemaining: vi.fn(() => '4:59'),
}));

vi.mock('../src/ui/prompts', () => ({
  p: {
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    })),
  },
}));

vi.mock('../src/config', () => ({
  addSession: vi.fn(),
  loadCliConfig: vi.fn(() => ({ sessions: [], preferredAgent: 'claude' })),
  saveCliConfig: vi.fn(),
}));

// A stub fake local credential so `locator.extract()` returns something,
// causing `link.ts` to take the "reuse existing creds" fast path (step 5)
// and call `uploadAndSucceed` without entering the 5-min credential-watcher.
const FAKE_LOCAL_TOKEN = {
  method: 'oauth' as const,
  credential: '{"accessToken":"sk-ant-test"}',
  source: '~/.claude/credentials.json',
};

vi.mock('../src/agents/registry', () => ({
  createRuntimeStrategy: vi.fn(() => ({
    id: 'claude',
    meta: { displayName: 'Claude Code', binaryName: 'claude' },
    os: { id: 'darwin' },
    credentialLocator: vi.fn(() => ({
      vendor: 'Anthropic',
      publicId: 'claude_code',
      hint: '~/.claude/credentials.json',
      extract: vi.fn(async () => FAKE_LOCAL_TOKEN),
      watchPaths: vi.fn(() => []),
    })),
    loginLauncher: vi.fn(() => ({
      ensureInstalled: vi.fn().mockResolvedValue(true),
      launch: vi.fn(() => ({ on: vi.fn(), kill: vi.fn(), killed: false })),
    })),
  })),
}));

// Mock pair-completion subscriber.
vi.mock('../src/services/pair-completion-subscriber', () => ({
  subscribeToPairCompletion: vi.fn(),
}));

// ── Import the modules AFTER vi.mock declarations ────────────────────────────

// Import pairing service using the REAL module — we spyOn individual
// functions per-test. This ensures postLinkCredential uses the same
// _transport object reference that our spy mutates.
import * as pairing from '../src/services/pairing.service';
import * as pairSubscriber from '../src/services/pair-completion-subscriber';
import * as banner from '../src/ui/banner';
import { link } from '../src/commands/link';

// ── Per-test setup / teardown ────────────────────────────────────────────────

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();

  exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((_code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${_code})`);
    });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helper ───────────────────────────────────────────────────────────────────

/**
 * Wire subscribeToPairCompletion to fire onPaired on the next microtask,
 * then run `link(['claude'])`.
 */
async function runLink(opts: {
  sessionId: string;
  pluginAuthToken?: string;
}): Promise<void> {
  // requestCode fast path.
  vi.spyOn(pairing._transport, 'postJson').mockResolvedValue({
    data: { code: 'ABC123', expiresAt: Date.now() + 5 * 60_000 },
  } as never);

  // subscribeToPairCompletion → fire onPaired on next microtask.
  vi.mocked(pairSubscriber.subscribeToPairCompletion).mockImplementation(
    (_pluginId, onPaired, _onTimeout, _pollSecret) => {
      Promise.resolve().then(() =>
        onPaired({
          sessionId: opts.sessionId,
          userName: 'Test User',
          userEmail: 'test@example.com',
          plan: 'PRO',
          pluginAuthToken: opts.pluginAuthToken,
        }),
      );
      return vi.fn();
    },
  );

  await link(['claude']);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('link — pluginAuthToken fallback via /api/pairing/reconnect', () => {
  it('resolves token via reconnect when pair_completed omits pluginAuthToken', async () => {
    // Reconnect returns a fresh token.
    const reconnectSpy = vi
      .spyOn(pairing, 'fetchCurrentPluginAuthToken')
      .mockResolvedValue('v1.reconnect-token');

    // postLinkCredential → success (spy on _transport.postJsonAuthed which
    // is the object used inside postLinkCredential).
    const postJsonAuthedSpy = vi
      .spyOn(pairing._transport, 'postJsonAuthed')
      .mockResolvedValue({ success: true } as never);

    await runLink({ sessionId: 'sess-abc' /* no pluginAuthToken */ });

    // fetchCurrentPluginAuthToken must have been called with the right sessionId.
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    const [calledSessionId, , calledPollSecret] = reconnectSpy.mock.calls[0];
    expect(calledSessionId).toBe('sess-abc');
    // pollSecret must be the non-empty raw secret generated by link.ts.
    expect(typeof calledPollSecret).toBe('string');
    expect((calledPollSecret ?? '').length).toBeGreaterThan(0);

    // The reconnect token must have been forwarded to postLinkCredential's
    // underlying HTTP call.
    expect(postJsonAuthedSpy).toHaveBeenCalledTimes(1);
    const [, , usedToken] = postJsonAuthedSpy.mock.calls[0];
    expect(usedToken).toBe('v1.reconnect-token');

    // No error exit.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits with a clear error when both pluginAuthToken and reconnect are unavailable', async () => {
    vi.spyOn(pairing, 'fetchCurrentPluginAuthToken').mockResolvedValue(null);

    await expect(runLink({ sessionId: 'sess-xyz' })).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(banner.showError).toHaveBeenCalledWith(
      expect.stringContaining('/api/pairing/reconnect'),
    );
  });

  it('uses paired.pluginAuthToken directly when backend supplies it (no reconnect call)', async () => {
    const reconnectSpy = vi.spyOn(pairing, 'fetchCurrentPluginAuthToken');

    const postJsonAuthedSpy = vi
      .spyOn(pairing._transport, 'postJsonAuthed')
      .mockResolvedValue({ success: true } as never);

    await runLink({
      sessionId: 'sess-direct',
      pluginAuthToken: 'v1.direct-token',
    });

    // Reconnect must NOT be called — the token was already present.
    expect(reconnectSpy).not.toHaveBeenCalled();

    // The direct token must have been forwarded to postLinkCredential.
    expect(postJsonAuthedSpy).toHaveBeenCalledTimes(1);
    const [, , usedToken] = postJsonAuthedSpy.mock.calls[0];
    expect(usedToken).toBe('v1.direct-token');

    expect(exitSpy).not.toHaveBeenCalled();
  });
});

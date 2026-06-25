import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── mocks ──────────────────────────────────────────────────────────────────
// vi.mock calls are hoisted by vitest so the mocked modules are in place
// before the `invite` import below resolves.
//
// NOTE: do NOT reference outer `const` variables inside vi.mock factories —
// the hoist moves the factory above those declarations and triggers a
// TDZ ReferenceError. Use vi.hoisted() to create values that are safe to
// reference from a hoisted factory.

const { postJsonAuthedMock } = vi.hoisted(() => ({
  postJsonAuthedMock: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  loadCliConfig: vi.fn(() => ({
    pluginId: 'global-plugin-id',
    activeSessionId: 'session-abc',
    sessions: [
      {
        id: 'session-abc',
        pluginId: 'plugin-abc',
        pluginAuthToken: 'tok-abc',
        userName: 'Test User',
        userEmail: 'test@example.com',
        plan: 'pro',
        pairedAt: 0,
        agent: 'claude',
      },
    ],
  })),
}));

vi.mock('../../src/ui/banner', () => ({
  showIntro: vi.fn(),
}));

// Provide the _transport object with the hoisted spy so the module-level
// `API_BASE = resolveApiBaseUrl()` call in invite.ts resolves at import time.
vi.mock('../../src/services/pairing.service', () => ({
  _transport: {
    postJsonAuthed: postJsonAuthedMock,
    postJson: vi.fn(),
    getJson: vi.fn(),
  },
}));

vi.mock('@codeagent/shared', () => ({
  resolveApiBaseUrl: () => 'https://api.test.example.com',
}));

import { invite } from '../../src/commands/invite';
import { loadCliConfig } from '../../src/config';

// ── helpers ────────────────────────────────────────────────────────────────

function captureConsole(): { lines: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  };
  return {
    lines: () => chunks.join('\n'),
    restore: () => {
      console.log = original;
    },
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('invite command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the referral link on a successful API response', async () => {
    postJsonAuthedMock.mockResolvedValueOnce({
      success: true,
      data: { code: 'REF123', link: 'https://codeagent-mobile.com/ref/REF123' },
    });

    const cap = captureConsole();
    await invite();
    cap.restore();

    const out = cap.lines();
    expect(out).toContain('https://codeagent-mobile.com/ref/REF123');
    expect(out).toContain('Invite your crew');
    expect(out).toContain('14 days of PRO');
  });

  it('calls the correct endpoint with plugin-auth headers and body', async () => {
    postJsonAuthedMock.mockResolvedValueOnce({
      success: true,
      data: { code: 'REF123', link: 'https://codeagent-mobile.com/ref/REF123' },
    });

    const cap = captureConsole();
    await invite();
    cap.restore();

    expect(postJsonAuthedMock).toHaveBeenCalledOnce();
    const [url, body, token] = postJsonAuthedMock.mock.calls[0] as [
      string,
      { sessionId: string; pluginId: string },
      string,
    ];
    expect(url).toBe('https://api.test.example.com/api/referrals/code');
    expect(body).toEqual({ sessionId: 'session-abc', pluginId: 'plugin-abc' });
    expect(token).toBe('tok-abc');
  });

  it('prints the pair-first message and makes NO network call when unpaired', async () => {
    vi.mocked(loadCliConfig).mockReturnValueOnce({
      pluginId: 'global-plugin-id',
      activeSessionId: null,
      sessions: [],
    });

    const cap = captureConsole();
    await invite();
    cap.restore();

    expect(postJsonAuthedMock).not.toHaveBeenCalled();
    const out = cap.lines();
    expect(out).toContain('codeam pair');
  });

  it('prints pair-first message when session exists but has no pluginAuthToken', async () => {
    vi.mocked(loadCliConfig).mockReturnValueOnce({
      pluginId: 'global-plugin-id',
      activeSessionId: 'session-abc',
      sessions: [
        {
          id: 'session-abc',
          pluginId: 'plugin-abc',
          // pluginAuthToken intentionally absent
          userName: 'Test User',
          userEmail: 'test@example.com',
          plan: 'free',
          pairedAt: 0,
          agent: 'claude' as const,
        },
      ],
    });

    const cap = captureConsole();
    await invite();
    cap.restore();

    expect(postJsonAuthedMock).not.toHaveBeenCalled();
    const out = cap.lines();
    expect(out).toContain('codeam pair');
  });

  it('prints an HTTP error message on a 4xx/5xx API error', async () => {
    const httpErr = Object.assign(new Error('HTTP 403: forbidden'), { statusCode: 403 });
    postJsonAuthedMock.mockRejectedValueOnce(httpErr);

    const cap = captureConsole();
    await invite();
    cap.restore();

    const out = cap.lines();
    expect(out).toContain('403');
    expect(out).toContain('codeam pair');
  });

  it('prints a generic connection error on a network failure (no statusCode)', async () => {
    postJsonAuthedMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const cap = captureConsole();
    await invite();
    cap.restore();

    const out = cap.lines();
    expect(out).toContain('reach the server');
  });
});

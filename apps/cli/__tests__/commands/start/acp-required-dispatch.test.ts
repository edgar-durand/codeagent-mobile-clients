/**
 * Regression coverage for the 2026-07-17 incident: an npm global reinstall
 * race deleted `@agentclientprotocol/claude-agent-acp` while a codespace
 * daemon was live. At session dispatch, `resolveBin()` returned `null` inside
 * its try/catch, `requiresAcp('claude')` was (at the time) DERIVED from
 * adapter resolution so it flipped to `false`, and `start.ts` silently fell
 * through to Claude's legacy PTY runtime — the app streamed raw Ink TUI (no
 * `select_prompt` buttons, echoed prompt).
 *
 * The fix makes `requiresAcp` a STATIC registry-membership check (see
 * `acp.dispatch.test.ts` for that unit) and makes `start.ts`'s dispatch FAIL
 * LOUDLY instead of downgrading to PTY when an ACP-required agent's adapter
 * cannot be resolved. This file drives the real `start()` orchestrator with
 * every side-effecty dependency stubbed, and asserts the dispatch OUTCOME:
 * which of `runAcpSession` / `surfaceStartupFailure` / the PTY
 * `createRuntimeStrategy` path actually ran.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeSessionBase = {
  id: 'sess-1',
  pluginId: 'plugin-1',
  userName: 'Test User',
  userEmail: 'test@example.com',
  plan: 'PRO',
  pairedAt: Date.now(),
  pluginAuthToken: 'tok-abc123',
  pollSecret: 'poll-secret',
};

vi.mock('../../../src/config', () => ({
  addSession: vi.fn(),
  getActiveSession: vi.fn(),
  getActiveSessionForAgent: vi.fn(),
  ensurePluginId: vi.fn(() => 'plugin-1'),
  loadCliConfig: vi.fn(() => ({ sessions: [] })),
}));

vi.mock('../../../src/commands/pair-auto', () => ({
  acquireDaemonLock: vi.fn(() => true),
}));

vi.mock('../../../src/commands/host-agent', () => ({
  maybeStartHeadroomReporter: vi.fn(() => null),
  maybeResumeLocalHeadroomReporter: vi.fn(() => null),
}));

vi.mock('../../../src/ui/banner', () => ({
  showIntro: vi.fn(),
  showInfo: vi.fn(),
  showError: vi.fn(),
}));

vi.mock('../../../src/services/pairing.service', () => ({
  fetchCurrentPluginAuthToken: vi.fn(async () => undefined),
  postPreviewEvent: vi.fn(),
}));

vi.mock('../../../src/services/telemetry.service', () => ({
  capture: vi.fn(),
  identifyUser: vi.fn(),
  shutdownTelemetry: vi.fn(),
}));

vi.mock('../../../src/agents/claude/onboarding', () => ({
  ensureClaudeOnboarded: vi.fn(),
}));

vi.mock('../../../src/beads/wiring', () => ({
  provisionBeadsForStart: vi.fn(async () => null),
}));

vi.mock('../../../src/integrations/provision', () => ({
  buildMcpServersForStart: vi.fn(() => []),
}));

vi.mock('../../../src/baton/gate', () => ({
  isLocalSession: vi.fn(() => false),
  runtimeSupportsBaton: vi.fn(() => false),
}));

vi.mock('../../../src/baton/wire-baton', () => ({
  runBatonSession: vi.fn(),
}));

vi.mock('../../../src/agents/registry', () => ({
  createRuntimeStrategy: vi.fn(() => {
    throw new Error('SENTINEL_PTY_REACHED');
  }),
}));

vi.mock('../../../src/agents/acp/runner', () => ({
  runAcpSession: vi.fn(async () => undefined),
  surfaceStartupFailure: vi.fn(async () => undefined),
}));

// Real `requiresAcp` (static registry check) but a controllable
// `getAcpAdapter` / `resolveAcpAdapterWithRetry` so we can simulate the
// exact incident (adapter genuinely unresolvable) without touching the real
// filesystem/module graph.
vi.mock('../../../src/agents/acp/adapters', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/agents/acp/adapters')>();
  return {
    ...actual,
    getAcpAdapter: vi.fn((agent: string) =>
      agent === 'claude' ? null : actual.getAcpAdapter(agent as never),
    ),
    resolveAcpAdapterWithRetry: vi.fn(async () => null),
  };
});

import { start } from '../../../src/commands/start';
import { getActiveSession, getActiveSessionForAgent } from '../../../src/config';
import { createRuntimeStrategy } from '../../../src/agents/registry';
import { runAcpSession, surfaceStartupFailure } from '../../../src/agents/acp/runner';

describe('start() dispatch — ACP-required agent with an unresolvable adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CODESPACES;
  });

  it('claude: FAILS LOUDLY (surfaceStartupFailure) — never runs the ACP session and never falls through to PTY', async () => {
    const session = { ...fakeSessionBase, agent: 'claude' as const };
    vi.mocked(getActiveSession).mockReturnValue(session as never);
    vi.mocked(getActiveSessionForAgent).mockReturnValue(session as never);

    await start();

    expect(surfaceStartupFailure).toHaveBeenCalledTimes(1);
    const call = vi.mocked(surfaceStartupFailure).mock.calls[0]![0] as { agent: string; detail: string };
    expect(call.agent).toBe('claude');
    expect(call.detail).toMatch(/ACP adapter is unavailable/i);

    // The core invariant: an ACP-required agent NEVER reaches the legacy PTY
    // runtime, whatever else goes wrong resolving its adapter.
    expect(createRuntimeStrategy).not.toHaveBeenCalled();
    expect(runAcpSession).not.toHaveBeenCalled();
  });

  it('aider: has no ACP adapter — still takes the legacy PTY runtime unchanged', async () => {
    const session = { ...fakeSessionBase, agent: 'aider' as const };
    vi.mocked(getActiveSession).mockReturnValue(session as never);
    vi.mocked(getActiveSessionForAgent).mockReturnValue(session as never);

    // createRuntimeStrategy is stubbed to throw a sentinel the instant it's
    // invoked — reaching it (and only it) is exactly what "still takes PTY"
    // means, without having to stand up the rest of the PTY run-loop.
    await expect(start()).rejects.toThrow('SENTINEL_PTY_REACHED');

    expect(createRuntimeStrategy).toHaveBeenCalledWith('aider');
    expect(runAcpSession).not.toHaveBeenCalled();
    expect(surfaceStartupFailure).not.toHaveBeenCalled();
  });
});

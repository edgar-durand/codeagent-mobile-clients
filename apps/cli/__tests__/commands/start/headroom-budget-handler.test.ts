/**
 * Tests for the `headroom_budget` relay command handler.
 *
 * The backend fans this command to ALL active relay sessions for the user
 * (PairedSession has no agentId). The handler therefore guards on:
 *   1. Headroom is ACTIVE in THIS session (enabled in config).
 *   2. This session's agent matches the command's `payload.agentId`.
 *   3. `isHeadroomSupportedAgent(agent)` — no budget for cursor/gemini/aider.
 *
 * When all three pass: persists budget into process.env + headroom config,
 * kills the proxy, relaunches with `buildBudgetProxyArgs`, returns
 * `{ applied: true }`.
 *
 * Otherwise: NO-OP → returns `{ applied: false }` (no proxy restart).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HandlerContext } from '../../../src/commands/start/handlers';
import type { RemoteCommand } from '../../../src/services/command-relay.service';
import type { CommandRelayService } from '../../../src/services/command-relay.service';
import type { StartCommandPayload } from '../../../src/lib/payload';

// ── Module mocks ─────────────────────────────────────────────────────────────

// Mock fs so we can control what headroomConfigPath() reads.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

// Mock child_process.spawn to prevent real proxy spawning.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const mockSpawnResult = {
    unref: vi.fn(),
    once: vi.fn(),
    pid: 12345,
  };
  return {
    ...actual,
    spawn: vi.fn().mockReturnValue(mockSpawnResult),
  };
});

// Mock host-agent helpers so we can control headroom state.
vi.mock('../../../src/commands/host-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/commands/host-agent')>();
  return {
    ...actual,
    agentIdToHeadroomKind: vi.fn((id: string) => (id === 'claude_code' ? 'claude' : id)),
    isHeadroomSupportedAgent: vi.fn((id: string) => ['claude', 'codex', 'copilot'].includes(id)),
    persistHeadroomConfig: vi.fn(),
    headroomConfigPath: vi.fn().mockReturnValue('/tmp/.codeam/headroom-config.json'),
    restoreAgentHeadroomConfig: vi.fn().mockReturnValue(true),
    setupHeadroomForSelfHosted: vi.fn().mockResolvedValue(true),
  };
});

// Mock stats-reporter so HeadroomStatsReporter constructor doesn't blow up.
vi.mock('../../../src/services/headroom/stats-reporter', () => ({
  HeadroomStatsReporter: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  mapStatsToSavings: vi.fn().mockReturnValue({ next: null }),
}));

// Mock pairing service (postHeadroomEvent used by headroom_configure; not directly by budget handler).
vi.mock('../../../src/services/pairing.service', () => ({
  postLinkCredential: vi.fn().mockResolvedValue({ ok: true }),
  postAiResult: vi.fn().mockResolvedValue({ ok: true }),
  postPreviewEvent: vi.fn().mockResolvedValue(undefined),
  postHeadroomEvent: vi.fn().mockResolvedValue(undefined),
  postBeadsEvent: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import * as fs from 'fs';
import { spawn } from 'child_process';
import { handlers } from '../../../src/commands/start/handlers';
import {
  isHeadroomSupportedAgent,
  persistHeadroomConfig,
  headroomConfigPath,
} from '../../../src/commands/host-agent';

const isHeadroomSupportedAgentMock = vi.mocked(isHeadroomSupportedAgent);
const persistHeadroomConfigMock = vi.mocked(persistHeadroomConfig);
const headroomConfigPathMock = vi.mocked(headroomConfigPath);
const spawnMock = vi.mocked(spawn);
const readFileSyncMock = vi.mocked(fs.readFileSync);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(agentId: string, opts: { pluginAuthToken?: string } = {}): HandlerContext {
  const relay = { sendResult: vi.fn().mockResolvedValue(undefined) } as unknown as CommandRelayService;
  return {
    outputSvc: {} as HandlerContext['outputSvc'],
    agent: {} as HandlerContext['agent'],
    historySvc: {} as HandlerContext['historySvc'],
    relay,
    runtime: {} as HandlerContext['runtime'],
    setKeepAlive: vi.fn(),
    keepAliveCtx: { inCodespace: false } as HandlerContext['keepAliveCtx'],
    pluginId: 'plug-budget-1',
    sessionId: 'sess-budget-1',
    agentId,
    pluginAuthToken: opts.pluginAuthToken,
    beads: null,
  };
}

function makeCmd(payload: Record<string, unknown> = {}): RemoteCommand {
  return {
    id: 'cmd-budget-1',
    sessionId: 'sess-budget-1',
    type: 'headroom_budget',
    payload,
  };
}

function p(payload: Record<string, unknown>): StartCommandPayload {
  return payload as unknown as StartCommandPayload;
}

/** Make readFileSync return an enabled headroom config for the given agent. */
function mockHeadroomEnabled(agent: string) {
  readFileSyncMock.mockImplementation((path, ...args) => {
    if (String(path).includes('headroom-config')) {
      return JSON.stringify({ enabled: true, agent });
    }
    // Fall through to actual for anything else.
    const actual = vi.importActual<typeof import('fs')>('fs');
    return (actual as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync(path as string, ...args as [BufferEncoding]);
  });
}

/** Make readFileSync return a DISABLED headroom config. */
function mockHeadroomDisabled() {
  readFileSyncMock.mockImplementation((path) => {
    if (String(path).includes('headroom-config')) {
      return JSON.stringify({ enabled: false });
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: headroom config path returns our fake path.
  headroomConfigPathMock.mockReturnValue('/tmp/.codeam/headroom-config.json');
  // Default spawn mock.
  spawnMock.mockReturnValue({ unref: vi.fn(), once: vi.fn(), pid: 12345 } as unknown as ReturnType<typeof spawn>);
  // Clear budget env vars between tests.
  delete process.env['HEADROOM_BUDGET'];
  delete process.env['HEADROOM_BUDGET_PERIOD'];
});

afterEach(() => {
  delete process.env['HEADROOM_BUDGET'];
  delete process.env['HEADROOM_BUDGET_PERIOD'];
});

describe('headroom_budget handler — applies + relaunches when headroom active and agent matches', () => {
  it('sets process.env budget vars and respawns proxy when headroom enabled and agent matches', async () => {
    mockHeadroomEnabled('claude');
    const ctx = makeCtx('claude');
    const cmd = makeCmd({ budgetEnabled: true, budgetUsd: 10, budgetPeriod: 'daily', agentId: 'claude' });

    await handlers.headroom_budget!(ctx, cmd, p(cmd.payload as Record<string, unknown>));

    // Budget env vars must be set on process.env.
    expect(process.env['HEADROOM_BUDGET']).toBe('10');
    expect(process.env['HEADROOM_BUDGET_PERIOD']).toBe('daily');

    // Proxy must be relaunched (spawn called with headroom proxy).
    expect(spawnMock).toHaveBeenCalledWith(
      'headroom',
      expect.arrayContaining(['proxy', '--port', '8787', '--budget', '10', '--budget-period', 'daily']),
      expect.objectContaining({ detached: true }),
    );

    // Result must be applied: true.
    expect(ctx.relay.sendResult).toHaveBeenCalledWith(cmd.id, 'completed', { applied: true });
  });

  it('clears budget env vars and respawns proxy (no budget args) when budgetEnabled is false', async () => {
    // Pre-set budget vars that should be cleared.
    process.env['HEADROOM_BUDGET'] = '5';
    process.env['HEADROOM_BUDGET_PERIOD'] = 'monthly';

    mockHeadroomEnabled('codex');
    const ctx = makeCtx('codex');
    const cmd = makeCmd({ budgetEnabled: false, agentId: 'codex' });

    await handlers.headroom_budget!(ctx, cmd, p(cmd.payload as Record<string, unknown>));

    // Budget vars must be cleared.
    expect(process.env['HEADROOM_BUDGET']).toBeUndefined();
    expect(process.env['HEADROOM_BUDGET_PERIOD']).toBeUndefined();

    // Proxy must be relaunched WITHOUT budget args.
    expect(spawnMock).toHaveBeenCalledWith(
      'headroom',
      ['proxy', '--port', '8787'],
      expect.objectContaining({ detached: true }),
    );

    expect(ctx.relay.sendResult).toHaveBeenCalledWith(cmd.id, 'completed', { applied: true });
  });

  it('uses ctx.agentId (not payload.agentId) as the authoritative session agent', async () => {
    mockHeadroomEnabled('copilot');
    const ctx = makeCtx('copilot');
    // Payload carries a different agentId — session agent wins for the guard.
    const cmd = makeCmd({ budgetEnabled: true, budgetUsd: 20, budgetPeriod: 'monthly', agentId: 'copilot' });

    await handlers.headroom_budget!(ctx, cmd, p(cmd.payload as Record<string, unknown>));

    expect(ctx.relay.sendResult).toHaveBeenCalledWith(cmd.id, 'completed', { applied: true });
  });

  it('normalises claude_code → claude for agent guard', async () => {
    mockHeadroomEnabled('claude');
    const ctx = makeCtx('claude_code');
    const cmd = makeCmd({ budgetEnabled: true, budgetUsd: 5, budgetPeriod: 'hourly', agentId: 'claude' });

    await handlers.headroom_budget!(ctx, cmd, p(cmd.payload as Record<string, unknown>));

    expect(ctx.relay.sendResult).toHaveBeenCalledWith(cmd.id, 'completed', { applied: true });
  });
});

describe('headroom_budget handler — no-op when headroom is inactive', () => {
  it('returns applied:false without touching env or proxy when headroom disabled', async () => {
    mockHeadroomDisabled();
    const ctx = makeCtx('claude');
    const cmd = makeCmd({ budgetEnabled: true, budgetUsd: 10, budgetPeriod: 'daily', agentId: 'claude' });

    await handlers.headroom_budget!(ctx, cmd, p(cmd.payload as Record<string, unknown>));

    expect(process.env['HEADROOM_BUDGET']).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(ctx.relay.sendResult).toHaveBeenCalledWith(cmd.id, 'completed', { applied: false });
  });

  it('returns applied:false when headroom config is missing (ENOENT)', async () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const ctx = makeCtx('claude');
    const cmd = makeCmd({ budgetEnabled: true, budgetUsd: 10, budgetPeriod: 'daily', agentId: 'claude' });

    await handlers.headroom_budget!(ctx, cmd, p(cmd.payload as Record<string, unknown>));

    expect(spawnMock).not.toHaveBeenCalled();
    expect(ctx.relay.sendResult).toHaveBeenCalledWith(cmd.id, 'completed', { applied: false });
  });
});

describe('headroom_budget handler — no-op when agentId does not match this session', () => {
  it('returns applied:false when payload.agentId targets a different agent than this session', async () => {
    // This session runs claude, but backend sent budget for codex.
    mockHeadroomEnabled('claude');
    const ctx = makeCtx('claude');
    const cmd = makeCmd({ budgetEnabled: true, budgetUsd: 10, budgetPeriod: 'daily', agentId: 'codex' });

    await handlers.headroom_budget!(ctx, cmd, p(cmd.payload as Record<string, unknown>));

    expect(spawnMock).not.toHaveBeenCalled();
    expect(ctx.relay.sendResult).toHaveBeenCalledWith(cmd.id, 'completed', { applied: false });
  });

  it('returns applied:false when session agent is cursor (unsupported)', async () => {
    // cursor is not headroom-supported
    isHeadroomSupportedAgentMock.mockImplementation((id) => ['claude', 'codex', 'copilot'].includes(id));
    mockHeadroomEnabled('cursor');
    const ctx = makeCtx('cursor');
    const cmd = makeCmd({ budgetEnabled: true, budgetUsd: 10, budgetPeriod: 'daily', agentId: 'cursor' });

    await handlers.headroom_budget!(ctx, cmd, p(cmd.payload as Record<string, unknown>));

    expect(spawnMock).not.toHaveBeenCalled();
    expect(ctx.relay.sendResult).toHaveBeenCalledWith(cmd.id, 'completed', { applied: false });
  });

  it('returns applied:false when session agent is gemini (unsupported)', async () => {
    isHeadroomSupportedAgentMock.mockImplementation((id) => ['claude', 'codex', 'copilot'].includes(id));
    mockHeadroomEnabled('gemini');
    const ctx = makeCtx('gemini');
    const cmd = makeCmd({ budgetEnabled: true, budgetUsd: 10, budgetPeriod: 'daily', agentId: 'gemini' });

    await handlers.headroom_budget!(ctx, cmd, p(cmd.payload as Record<string, unknown>));

    expect(spawnMock).not.toHaveBeenCalled();
    expect(ctx.relay.sendResult).toHaveBeenCalledWith(cmd.id, 'completed', { applied: false });
  });

  it('returns applied:false when payload has no agentId and ctx.agentId is empty', async () => {
    mockHeadroomEnabled('claude');
    const ctx = makeCtx('');
    const cmd = makeCmd({ budgetEnabled: true, budgetUsd: 10, budgetPeriod: 'daily' });

    await handlers.headroom_budget!(ctx, cmd, p(cmd.payload as Record<string, unknown>));

    // No agentId to match → no-op.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(ctx.relay.sendResult).toHaveBeenCalledWith(cmd.id, 'completed', { applied: false });
  });
});

describe('headroom_budget handler — handler is registered in dispatch table', () => {
  it('headroom_budget is a registered handler', () => {
    expect(typeof handlers.headroom_budget).toBe('function');
  });
});

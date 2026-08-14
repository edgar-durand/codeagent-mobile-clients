/**
 * Unit tests for the in-session agent switch (`switch_agent`) orchestration —
 * target validation, credential/auth mapping, binary ensure branches, the
 * handoff preamble, event ordering, and the revert-on-failure state machine.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolveSwitchTarget,
  toAgentAuth,
  buildHandoffPreamble,
  ensureAgentBinaryForSwitch,
  makeSerializedSwitchEmitter,
  performAgentSwitch,
  type SwitchAgentDeps,
} from '../../../src/agents/acp/switch-agent';
import { AcpHistory } from '../../../src/agents/acp/runner';
import type { AgentId } from '@codeam/shared';

// ─── resolveSwitchTarget ─────────────────────────────────────────────────────

describe('resolveSwitchTarget', () => {
  it('rejects a missing agentId', () => {
    const r = resolveSwitchTarget(undefined, 'claude');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing agentId/);
  });

  it('rejects an unknown agent id', () => {
    const r = resolveSwitchTarget('not-an-agent', 'claude');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unknown agent/);
  });

  it('rejects coderabbit — reviewer, never a session driver', () => {
    const r = resolveSwitchTarget('coderabbit', 'claude');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/reviewer/);
  });

  it('rejects a non-ACP agent (aider is PTY-only)', () => {
    const r = resolveSwitchTarget('aider', 'claude');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/can't be switched/);
  });

  it('rejects switching to the agent already running', () => {
    const r = resolveSwitchTarget('claude', 'claude');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already/);
  });

  it('accepts a known ACP agent different from the current one', () => {
    const r = resolveSwitchTarget('codex', 'claude');
    expect(r).toEqual({ ok: true, agentId: 'codex' });
  });
});

// ─── toAgentAuth ─────────────────────────────────────────────────────────────

describe('toAgentAuth', () => {
  it('maps api_key → api_key', () => {
    expect(toAgentAuth('api_key', 'sk-123')).toEqual({ kind: 'api_key', value: 'sk-123' });
  });
  it('maps oauth → oauth_token (an OAuth blob is NOT an API key)', () => {
    expect(toAgentAuth('oauth', '{"accessToken":"x"}')).toEqual({
      kind: 'oauth_token',
      value: '{"accessToken":"x"}',
    });
  });
});

// ─── buildHandoffPreamble ────────────────────────────────────────────────────

describe('buildHandoffPreamble', () => {
  it('returns null for an empty transcript (no pointless preamble)', () => {
    expect(buildHandoffPreamble('claude', 'codex', '   \n ')).toBeNull();
  });

  it('names both agents and embeds the transcript', () => {
    const p = buildHandoffPreamble('claude', 'codex', 'User: hola\n\nAgent: hola!');
    expect(p).toContain('Codex CLI');
    expect(p).toContain('Claude Code');
    expect(p).toContain('User: hola');
    expect(p).toContain('taking over');
  });

  it('uses restart copy when from === to (the revert path)', () => {
    const p = buildHandoffPreamble('claude', 'claude', 'User: hola');
    expect(p).toContain('resuming a live coding session after a restart');
    expect(p).not.toContain('taking over');
  });
});

// ─── AcpHistory.recentTranscript ─────────────────────────────────────────────

describe('AcpHistory.recentTranscript', () => {
  const publisher = {
    pushSessionList: vi.fn().mockResolvedValue(undefined),
    pushConversation: vi.fn().mockResolvedValue(undefined),
  };
  const makeHistory = () =>
    // Only the two push methods are used by AcpHistory.
    new AcpHistory(publisher as never, { agent: 'claude', acpSessionId: 's1' });

  it('renders role-labelled turns in chronological order', () => {
    const h = makeHistory();
    h.appendUserPrompt('first question');
    h.appendAgentReply('first answer');
    h.appendUserPrompt('second question');
    const t = h.recentTranscript(10_000);
    expect(t).toBe('User: first question\n\nAgent: first answer\n\nUser: second question');
  });

  it('keeps the NEWEST turns when the cap truncates', () => {
    const h = makeHistory();
    h.appendUserPrompt('x'.repeat(200));
    h.appendAgentReply('old '.repeat(50));
    h.appendUserPrompt('the newest question');
    const t = h.recentTranscript(60);
    expect(t).toContain('the newest question');
    expect(t).not.toContain('x'.repeat(200));
  });

  it('is empty for a fresh session', () => {
    expect(makeHistory().recentTranscript(1000)).toBe('');
  });
});

// ─── ensureAgentBinaryForSwitch ──────────────────────────────────────────────

function fakeSpec(waits: boolean[] | boolean) {
  const seq = Array.isArray(waits) ? [...waits] : [waits];
  return {
    command: 'x',
    args: [],
    requiresAgentBinary: 'codex',
    waitForBinary: vi.fn(async () => (seq.length > 1 ? seq.shift()! : seq[0])),
  };
}

describe('ensureAgentBinaryForSwitch', () => {
  it('fails when the adapter is unresolvable', async () => {
    const r = await ensureAgentBinaryForSwitch('codex', undefined, {
      resolveAdapter: () => null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/adapter is unavailable/);
  });

  it('resolves instantly when the binary is present (baked image)', async () => {
    const runInstall = vi.fn();
    const r = await ensureAgentBinaryForSwitch('codex', 'echo install', {
      resolveAdapter: () => fakeSpec(true),
      runInstall: runInstall as never,
    });
    expect(r.ok).toBe(true);
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('fails honestly when missing and no install script was provided', async () => {
    const r = await ensureAgentBinaryForSwitch('codex', undefined, {
      resolveAdapter: () => fakeSpec(false),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not installed/);
  });

  it('runs the install script and succeeds once the binary appears', async () => {
    const runInstall = vi.fn(async () => ({ ok: true, code: 0, timedOut: false }));
    const r = await ensureAgentBinaryForSwitch('codex', 'curl install.sh | sh', {
      resolveAdapter: () => fakeSpec([false, true]),
      runInstall: runInstall as never,
    });
    expect(r.ok).toBe(true);
    expect(runInstall).toHaveBeenCalledOnce();
  });

  it('fails when the install script exits non-zero', async () => {
    const r = await ensureAgentBinaryForSwitch('codex', 'exit 1', {
      resolveAdapter: () => fakeSpec(false),
      runInstall: vi.fn(async () => ({ ok: false, code: 1, timedOut: false })) as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/install failed/);
  });

  it('reports a timeout distinctly', async () => {
    const r = await ensureAgentBinaryForSwitch('codex', 'sleep forever', {
      resolveAdapter: () => fakeSpec(false),
      runInstall: vi.fn(async () => ({ ok: false, code: null, timedOut: true })) as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/timed out/);
  });
});

// ─── makeSerializedSwitchEmitter ─────────────────────────────────────────────

describe('makeSerializedSwitchEmitter', () => {
  it('serializes POSTs strictly in emit order even when the poster is slow', async () => {
    const done: string[] = [];
    const post = vi.fn(
      (type: string, payload: Record<string, unknown>) =>
        new Promise((resolve) =>
          // First POST is the slowest — ordering must still hold.
          setTimeout(() => {
            done.push(`${type}:${String(payload.step ?? payload.state)}`);
            resolve(undefined);
          }, done.length === 0 ? 30 : 1),
        ),
    );
    const emit = makeSerializedSwitchEmitter(post as never);
    void emit('switch_agent_status', { state: 'switching' });
    void emit('switch_agent_progress', { step: 'credential' });
    await emit('switch_agent_progress', { step: 'install' });
    expect(done).toEqual([
      'switch_agent_status:switching',
      'switch_agent_progress:credential',
      'switch_agent_progress:install',
    ]);
  });
});

// ─── performAgentSwitch state machine ────────────────────────────────────────

interface DepOverrides extends Partial<SwitchAgentDeps> {}

function makeDeps(overrides: DepOverrides = {}) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const deps: SwitchAgentDeps = {
    currentAgent: () => 'claude' as AgentId,
    postEvent: async (type, payload) => {
      events.push({ type, payload });
    },
    fetchCredential: async () => ({
      method: 'oauth' as const,
      credential: '{"t":1}',
      installScript: 'echo hi',
    }),
    provisionCredential: () => {
      calls.push('provision');
    },
    ensureBinary: async () => {
      calls.push('ensureBinary');
      return { ok: true as const };
    },
    swapRuntime: async () => {
      calls.push('swap');
    },
    revertRuntime: async () => {
      calls.push('revert');
    },
    persistAgent: () => {
      calls.push('persist');
    },
    reannounce: () => {
      calls.push('reannounce');
    },
    ...overrides,
  };
  return { deps, events, calls };
}

describe('performAgentSwitch', () => {
  it('happy path: events in order, persist + reannounce, ok result', async () => {
    const { deps, events, calls } = makeDeps();
    const result = await performAgentSwitch(deps, 'codex');
    expect(result).toEqual({ ok: true, agentId: 'codex' });
    expect(calls).toEqual(['provision', 'ensureBinary', 'swap', 'persist', 'reannounce']);
    expect(events.map((e) => `${e.type}:${String(e.payload.state ?? e.payload.step)}`)).toEqual([
      'switch_agent_status:switching',
      'switch_agent_progress:credential',
      'switch_agent_progress:install',
      'switch_agent_progress:restart',
      'switch_agent_status:ready',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ agentId: 'codex', fromAgentId: 'claude' });
  });

  it('invalid target: no events, no side effects', async () => {
    const { deps, events, calls } = makeDeps();
    const result = await performAgentSwitch(deps, 'coderabbit');
    expect(result.ok).toBe(false);
    expect(events).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('no vaulted credential: error status, session untouched', async () => {
    const { deps, events, calls } = makeDeps({ fetchCredential: async () => null });
    const result = await performAgentSwitch(deps, 'codex');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Link it in Profile/);
    expect(calls).toEqual([]);
    expect(events.at(-1)?.payload).toMatchObject({ state: 'error' });
  });

  it('binary ensure failure: error status, swap never attempted', async () => {
    const { deps, events, calls } = makeDeps({
      ensureBinary: async () => ({ ok: false as const, error: 'no binary' }),
    });
    const result = await performAgentSwitch(deps, 'codex');
    expect(result).toMatchObject({ ok: false, error: 'no binary' });
    expect(calls).not.toContain('swap');
    expect(events.at(-1)?.payload).toMatchObject({ state: 'error', error: 'no binary' });
  });

  it('swap failure: reverts to the prior agent and reports error', async () => {
    const reverted: AgentId[] = [];
    const { deps, events, calls } = makeDeps({
      swapRuntime: async () => {
        throw new Error('adapter died');
      },
      revertRuntime: async (agentId) => {
        reverted.push(agentId);
      },
    });
    const result = await performAgentSwitch(deps, 'codex');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/stays on Claude Code/);
    expect(reverted).toEqual(['claude']);
    expect(calls).not.toContain('persist');
    expect(events.at(-1)?.payload).toMatchObject({ state: 'error' });
  });

  it('swap AND revert failure: tells the user to restart the session', async () => {
    const { deps } = makeDeps({
      swapRuntime: async () => {
        throw new Error('adapter died');
      },
      revertRuntime: async () => {
        throw new Error('old agent also dead');
      },
    });
    const result = await performAgentSwitch(deps, 'codex');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/restart the session/);
  });

  // ─── Agent Squad fast path (routeToAgent) ─────────────────────────────────

  it('fast path: provisioned+verified member skips credential and install steps', async () => {
    const { deps, events, calls } = makeDeps();
    const result = await performAgentSwitch(deps, 'codex', {
      skipProvision: true,
      skipInstall: true,
    });
    expect(result).toEqual({ ok: true, agentId: 'codex' });
    // No provision, no ensureBinary — only the restart + durability half.
    expect(calls).toEqual(['swap', 'persist', 'reannounce']);
    expect(events.map((e) => `${e.type}:${String(e.payload.state ?? e.payload.step)}`)).toEqual([
      'switch_agent_status:switching',
      'switch_agent_progress:restart',
      'switch_agent_status:ready',
    ]);
  });

  it('fast path: skipping only the credential still runs the binary probe', async () => {
    const { deps, calls } = makeDeps();
    const result = await performAgentSwitch(deps, 'codex', { skipProvision: true });
    expect(result).toEqual({ ok: true, agentId: 'codex' });
    expect(calls).toEqual(['ensureBinary', 'swap', 'persist', 'reannounce']);
  });

  it('fast path still reverts on swap failure', async () => {
    const reverted: AgentId[] = [];
    const { deps, events } = makeDeps({
      swapRuntime: async () => {
        throw new Error('adapter died');
      },
      revertRuntime: async (agentId) => {
        reverted.push(agentId);
      },
    });
    const result = await performAgentSwitch(deps, 'codex', {
      skipProvision: true,
      skipInstall: true,
    });
    expect(result.ok).toBe(false);
    expect(reverted).toEqual(['claude']);
    expect(events.at(-1)?.payload).toMatchObject({ state: 'error' });
  });

  it('fast path still validates the target (never swaps to a reviewer)', async () => {
    const { deps, calls } = makeDeps();
    const result = await performAgentSwitch(deps, 'coderabbit', {
      skipProvision: true,
      skipInstall: true,
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('persist failure is non-fatal — the switch still completes', async () => {
    const { deps } = makeDeps({
      persistAgent: () => {
        throw new Error('disk full');
      },
    });
    const result = await performAgentSwitch(deps, 'codex');
    expect(result).toEqual({ ok: true, agentId: 'codex' });
  });
});

/**
 * Tests for budgetRecovery.ts
 *
 * Verified live (2026-06-28):
 *   headroom proxy --budget 0 --budget-period daily
 *   → POST /v1/messages → HTTP 429 {"detail":"Budget exceeded for daily period"}
 *
 * Covers:
 *   - looksLikeBudgetExceeded: positive (real body) + negatives
 *   - BudgetRecovery.offer: emits two-option select_prompt + awaiting-answer
 *   - BudgetRecovery.tryRecover('pause'): relaunches proxy without budget
 *   - BudgetRecovery.tryRecover('raise'): emits deep-link chunk
 *   - no pending → tryRecover returns false
 *   - only fires once per offer (pending cleared)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  looksLikeBudgetExceeded,
  extractBudgetPeriod,
  createBudgetRecovery,
  BUDGET_PAUSE_OPTION,
  BUDGET_RAISE_OPTION,
} from '../../../src/agents/acp/budgetRecovery';

// ─── looksLikeBudgetExceeded ─────────────────────────────────────────────────

describe('looksLikeBudgetExceeded', () => {
  it('matches the LIVE 429 body verbatim', () => {
    // Exact body observed from: headroom proxy --budget 0 --budget-period daily
    // HTTP 429 {"detail":"Budget exceeded for daily period"}
    expect(looksLikeBudgetExceeded('{"detail":"Budget exceeded for daily period"}')).toBe(true);
  });

  it('matches the detail string alone (as forwarded by the ACP error chain)', () => {
    expect(looksLikeBudgetExceeded('Budget exceeded for daily period')).toBe(true);
    expect(looksLikeBudgetExceeded('Budget exceeded for hourly period')).toBe(true);
    expect(looksLikeBudgetExceeded('Budget exceeded for monthly period')).toBe(true);
  });

  it('is case-insensitive (handles uppercase variants)', () => {
    expect(looksLikeBudgetExceeded('BUDGET EXCEEDED FOR DAILY PERIOD')).toBe(true);
    expect(looksLikeBudgetExceeded('budget exceeded for daily period')).toBe(true);
  });

  it('matches when the detail is embedded in a longer error string', () => {
    expect(
      looksLikeBudgetExceeded('Internal error: API Error: 429 {"detail":"Budget exceeded for daily period"}'),
    ).toBe(true);
  });

  it('does NOT match unrelated 429s (rate limit, 1M context, auth)', () => {
    for (const t of [
      'rate limit: 429 too many requests',
      'Usage credits required for 1M context',
      'API Error: 401 Invalid authentication credentials',
      'overloaded_error',
      'connect ECONNREFUSED 127.0.0.1:8787',
      'Usage limit reached',
    ]) {
      expect(looksLikeBudgetExceeded(t)).toBe(false);
    }
  });

  it('does NOT match an empty string', () => {
    expect(looksLikeBudgetExceeded('')).toBe(false);
  });
});

// ─── extractBudgetPeriod ─────────────────────────────────────────────────────

describe('extractBudgetPeriod', () => {
  it('extracts "daily" from the live body', () => {
    expect(extractBudgetPeriod('Budget exceeded for daily period')).toBe('daily');
  });
  it('extracts "hourly"', () => {
    expect(extractBudgetPeriod('Budget exceeded for hourly period')).toBe('hourly');
  });
  it('extracts "monthly"', () => {
    expect(extractBudgetPeriod('Budget exceeded for monthly period')).toBe('monthly');
  });
  it('falls back to "current" when no pattern matches', () => {
    expect(extractBudgetPeriod('some unrelated error')).toBe('current');
  });
});

// ─── createBudgetRecovery ────────────────────────────────────────────────────

type ChunkCall = Record<string, unknown>;

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: {
    texts: string[];
    selectPrompts: Array<{ question: string; options: string[] }>;
    awaitingAnswers: Array<{ prompt: string; options: string[] }>;
    rawChunks: ChunkCall[];
    results: Array<[string, string, Record<string, unknown>]>;
  } = {
    texts: [],
    selectPrompts: [],
    awaitingAnswers: [],
    rawChunks: [],
    results: [],
  };

  const deps = {
    publishText: vi.fn(async (text: string) => {
      calls.texts.push(text);
    }),
    publishSelectPrompt: vi.fn(async (question: string, options: string[]) => {
      calls.selectPrompts.push({ question, options });
    }),
    publishAwaitingAnswer: vi.fn(async (prompt: string, options: string[]) => {
      calls.awaitingAnswers.push({ prompt, options });
    }),
    publishRawChunk: vi.fn(async (chunk: ChunkCall) => {
      calls.rawChunks.push(chunk);
    }),
    sendResult: vi.fn(
      async (commandId: string, status: string, result: Record<string, unknown>) => {
        calls.results.push([commandId, status, result]);
      },
    ),
    appendAgentReply: vi.fn(),
    flushHistory: vi.fn(),
    relaunchProxyWithoutBudget: vi.fn(async () => {}),
    agentId: 'claude',
    log: vi.fn(),
    ...overrides,
  };

  return { deps, calls };
}

const BLOCKS = [{ type: 'text', text: 'What is TypeScript?' }] as const;
const DAILY_DETAIL = 'Budget exceeded for daily period';

describe('createBudgetRecovery — offer', () => {
  it('emits a two-option awaiting-answer (the tappable button driver)', async () => {
    const { deps, calls } = makeDeps();
    const rec = createBudgetRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS, DAILY_DETAIL);

    // The button driver: mobile renders tappable options from awaiting-answer.
    expect(calls.awaitingAnswers).toHaveLength(1);
    expect(calls.awaitingAnswers[0].options).toEqual([BUDGET_PAUSE_OPTION, BUDGET_RAISE_OPTION]);
  });

  it('emits a select_prompt chunk with the two options', async () => {
    const { deps, calls } = makeDeps();
    const rec = createBudgetRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS, DAILY_DETAIL);

    expect(calls.selectPrompts).toHaveLength(1);
    expect(calls.selectPrompts[0].options).toEqual([BUDGET_PAUSE_OPTION, BUDGET_RAISE_OPTION]);
  });

  it('publishes a visible text bubble mentioning the period', async () => {
    const { deps, calls } = makeDeps();
    const rec = createBudgetRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS, DAILY_DETAIL);

    expect(calls.texts).toHaveLength(1);
    expect(calls.texts[0]).toContain('daily');
  });

  it('appends the question to history and flushes', async () => {
    const { deps } = makeDeps();
    const rec = createBudgetRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS, DAILY_DETAIL);

    expect(deps.appendAgentReply).toHaveBeenCalled();
    expect(deps.flushHistory).toHaveBeenCalled();
  });

  it('ends the command as "failed" (recovery offered, not completed)', async () => {
    const { deps, calls } = makeDeps();
    const rec = createBudgetRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS, DAILY_DETAIL);

    expect(calls.results).toEqual([['cmd-1', 'failed', expect.objectContaining({ error: expect.stringContaining('budget exceeded') })]]);
  });

  it('extracts the period from the detail for the question text', async () => {
    const { deps, calls } = makeDeps();
    const rec = createBudgetRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS, 'Budget exceeded for monthly period');

    expect(calls.texts[0]).toContain('monthly');
  });
});

describe('createBudgetRecovery — tryRecover pause (optionIndex 0)', () => {
  it('relaunches the proxy without budget and completes the command', async () => {
    const { deps, calls } = makeDeps();
    const rec = createBudgetRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS, DAILY_DETAIL);
    const handled = await rec.tryRecover('cmd-2', 0);

    expect(handled).toBe(true);
    expect(deps.relaunchProxyWithoutBudget).toHaveBeenCalledTimes(1);
    // Acked as completed with action='pause'
    const completedResult = calls.results.find(([id]) => id === 'cmd-2');
    expect(completedResult).toBeDefined();
    expect(completedResult![1]).toBe('completed');
    expect(completedResult![2]).toMatchObject({ action: 'pause' });
  });

  it('publishes a confirmation bubble after relaunch', async () => {
    const { deps, calls } = makeDeps();
    const rec = createBudgetRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS, DAILY_DETAIL);
    await rec.tryRecover('cmd-2', 0);

    // offer() publishes 1 text, tryRecover(pause) publishes 1 more confirmation
    expect(calls.texts.length).toBeGreaterThanOrEqual(2);
    const lastText = calls.texts[calls.texts.length - 1];
    expect(lastText).toMatch(/paused|session/i);
  });

  it('clears pending after first tryRecover (single-fire)', async () => {
    const { deps } = makeDeps();
    const rec = createBudgetRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS, DAILY_DETAIL);
    expect(await rec.tryRecover('cmd-2', 0)).toBe(true);
    expect(await rec.tryRecover('cmd-3', 0)).toBe(false);
  });

  it('relaunch failure is best-effort — still completes the command', async () => {
    const { deps, calls } = makeDeps({
      relaunchProxyWithoutBudget: vi.fn(async () => {
        throw new Error('pkill not found');
      }),
    });
    const rec = createBudgetRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS, DAILY_DETAIL);
    const handled = await rec.tryRecover('cmd-2', 0);

    expect(handled).toBe(true);
    const result = calls.results.find(([id]) => id === 'cmd-2');
    expect(result?.[1]).toBe('completed');
  });
});

describe('createBudgetRecovery — tryRecover raise (optionIndex 1)', () => {
  it('emits a deep-link chunk with open_agent_budget_settings', async () => {
    const { deps, calls } = makeDeps();
    const rec = createBudgetRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS, DAILY_DETAIL);
    const handled = await rec.tryRecover('cmd-2', 1);

    expect(handled).toBe(true);
    expect(deps.relaunchProxyWithoutBudget).not.toHaveBeenCalled();
    // Deep-link chunk
    expect(calls.rawChunks).toHaveLength(1);
    expect(calls.rawChunks[0]).toMatchObject({
      type: 'open_agent_budget_settings',
      agentId: 'claude',
      done: true,
    });
  });

  it('acks the select_option as completed with action=raise', async () => {
    const { deps, calls } = makeDeps();
    const rec = createBudgetRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS, DAILY_DETAIL);
    await rec.tryRecover('cmd-2', 1);

    const result = calls.results.find(([id]) => id === 'cmd-2');
    expect(result?.[1]).toBe('completed');
    expect(result?.[2]).toMatchObject({ action: 'raise', agentId: 'claude' });
  });
});

describe('createBudgetRecovery — tryRecover with nothing pending', () => {
  it('returns false without touching any dep', async () => {
    const { deps } = makeDeps();
    const rec = createBudgetRecovery(deps as never);
    expect(await rec.tryRecover('cmd-x', 0)).toBe(false);
    expect(deps.relaunchProxyWithoutBudget).not.toHaveBeenCalled();
    expect(deps.publishRawChunk).not.toHaveBeenCalled();
  });
});

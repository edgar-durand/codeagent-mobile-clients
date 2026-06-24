import { describe, it, expect } from 'vitest';
import {
  ONE_M_DISABLE_OPTION,
  shouldOfferOneMRecovery,
  oneMRecoverySelectPrompt,
  makeOneMRecoveryState,
} from '../../src/agents/acp/oneMContextRecovery';

describe('oneMContextRecovery', () => {
  it('offers recovery when the 1M-credits error appears in detail, stderr, or the reply text', () => {
    expect(
      shouldOfferOneMRecovery({ detail: 'Usage credits required for 1M context', recentStderr: '', finalText: '' }),
    ).toBe(true);
    expect(
      shouldOfferOneMRecovery({ detail: '', recentStderr: 'usage credits required for 1m context', finalText: '' }),
    ).toBe(true);
    expect(
      shouldOfferOneMRecovery({ detail: '', recentStderr: '', finalText: 'API Error: Usage credits required for 1M context' }),
    ).toBe(true);
  });

  it('does NOT offer recovery for unrelated failures', () => {
    expect(shouldOfferOneMRecovery({ detail: 'socket hang up', recentStderr: '', finalText: '' })).toBe(false);
    expect(shouldOfferOneMRecovery({ detail: '401 unauthorized', recentStderr: '', finalText: '' })).toBe(false);
  });

  it('the select prompt offers exactly the disable option + names 1M context', () => {
    const p = oneMRecoverySelectPrompt();
    expect(p.options).toEqual([ONE_M_DISABLE_OPTION]);
    expect(p.question.toLowerCase()).toContain('1m context');
  });

  it('state starts empty', () => {
    expect(makeOneMRecoveryState().pending).toBeNull();
  });
});

import { vi } from 'vitest';
import { createOneMRecovery } from '../../src/agents/acp/oneMContextRecovery';

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: { selectPrompt: string[][]; texts: string[]; results: Array<[string, string]> } = {
    selectPrompt: [], texts: [], results: [],
  };
  const deps = {
    publishText: vi.fn(async (t: string) => { calls.texts.push(t); }),
    publishSelectPrompt: vi.fn(async (_q: string, options: string[]) => { calls.selectPrompt.push(options); }),
    sendResult: vi.fn(async (_id: string, status: string) => { calls.results.push([_id, status]); }),
    appendAgentReply: vi.fn(),
    flushHistory: vi.fn(),
    beginTurn: vi.fn(async () => {}),
    getCurrentText: vi.fn(() => 'Hello from claude'),
    closeTurn: vi.fn(async () => {}),
    recoverFromFailedTurn: vi.fn(async () => {}),
    reconnectWith1mDisabled: vi.fn(async () => {}),
    promptAgent: vi.fn(async () => ({ stopReason: 'end_turn' })),
    failureBubbleFor: vi.fn(() => '⚠️ retry'),
    describeError: vi.fn((e: unknown) => String(e)),
    log: vi.fn(),
    ...overrides,
  };
  return { deps, calls };
}

describe('createOneMRecovery', () => {
  const BLOCKS = [{ type: 'text', text: 'Hola' }];

  it('offer publishes the disable action + ends the turn failed + stashes the prompt', async () => {
    const { deps, calls } = makeDeps();
    const rec = createOneMRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS);
    expect(calls.selectPrompt).toEqual([[ONE_M_DISABLE_OPTION]]);
    expect(deps.appendAgentReply).toHaveBeenCalled();
    expect(calls.results).toEqual([['cmd-1', 'failed']]);
  });

  it('tryRecover (pending) disables 1M, re-spawns, re-runs the prompt, completes', async () => {
    const { deps, calls } = makeDeps();
    const rec = createOneMRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS);
    const handled = await rec.tryRecover('cmd-2');
    expect(handled).toBe(true);
    expect(deps.reconnectWith1mDisabled).toHaveBeenCalledTimes(1);
    expect(deps.promptAgent).toHaveBeenCalledWith(BLOCKS);
    expect(deps.closeTurn).toHaveBeenCalled();
    expect(calls.results).toContainEqual(['cmd-2', 'completed']);
  });

  it('tryRecover with nothing pending is a no-op returning false', async () => {
    const { deps } = makeDeps();
    const rec = createOneMRecovery(deps as never);
    expect(await rec.tryRecover('cmd-x')).toBe(false);
    expect(deps.reconnectWith1mDisabled).not.toHaveBeenCalled();
  });

  it('tryRecover only fires once per offer (pending cleared)', async () => {
    const { deps } = makeDeps();
    const rec = createOneMRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS);
    expect(await rec.tryRecover('cmd-2')).toBe(true);
    expect(await rec.tryRecover('cmd-3')).toBe(false);
  });

  it('a failed re-run surfaces a failure bubble + fails the command', async () => {
    const { deps, calls } = makeDeps({
      promptAgent: vi.fn(async () => { throw new Error('still broken'); }),
    });
    const rec = createOneMRecovery(deps as never);
    await rec.offer('cmd-1', BLOCKS);
    await rec.tryRecover('cmd-2');
    expect(deps.recoverFromFailedTurn).toHaveBeenCalled();
    expect(deps.failureBubbleFor).toHaveBeenCalled();
    expect(calls.results).toContainEqual(['cmd-2', 'failed']);
  });
});

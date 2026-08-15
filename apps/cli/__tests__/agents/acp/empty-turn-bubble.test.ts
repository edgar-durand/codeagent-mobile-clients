/**
 * A `start_task` turn that completes cleanly (no throw, `stopReason:
 * 'end_turn'`) but the agent's OWN ACP server streamed ZERO visible content
 * — no assistant text, no thinking, no tool activity — must NOT end
 * silently. Observed live on kimi-code 0.36.0 (fleet-1, 2026-08-14): its ACP
 * server swallowed a provider 402 membership error and just ended the turn
 * with `stopReason: 'end_turn'` and no `agent_message_chunk` updates at all
 * — the phone showed nothing (the only frame is an empty `done:true`, which
 * the mobile snapshot-guard drops).
 *
 * `emptyReplyMessage` (failure-messages.ts) is the honest bubble the runner
 * now publishes instead — same "never end silently" contract
 * `TURN_FAILURE_MESSAGE` already guarantees on the THROWN-error path, just
 * reached via a clean resolve here.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  dispatchAcpCommand,
  assembleAcpCommandContext,
  type AcpSessionContext,
} from '../../../src/agents/acp/command-handlers';
import { emptyReplyMessage } from '../../../src/agents/acp/failure-messages';
import type { RemoteCommand } from '@codeam/shared';

function startTask(payload: Record<string, unknown>, id = 'cmd-1'): RemoteCommand {
  return {
    id,
    sessionId: 's1',
    pluginId: 'p1',
    type: 'start_task',
    payload,
    status: 'pending',
    createdAt: Date.now(),
  } as unknown as RemoteCommand;
}

interface CtxOverrides {
  agent?: string;
  /** What `client.prompt` resolves with — mirrors the ACP adapter's reply. */
  stopReason?: string;
  /** What `streaming.getCurrentText()` returns (the turn's chat text). */
  replyText?: string;
  /** What `streaming.hasVisibleProgress()` returns (text OR thinking/tool activity). */
  hasVisibleProgress?: boolean;
}

function makeCtx(over: CtxOverrides = {}) {
  const opts = { agent: over.agent ?? 'kimi', sessionId: 's1', pluginId: 'p1' };
  const client = {
    prompt: vi.fn(async () => ({ stopReason: over.stopReason ?? 'end_turn' })),
    cancel: vi.fn(async () => undefined),
  };
  const bubbles: string[] = [];
  const streaming = {
    beginTurn: vi.fn(async () => undefined),
    getCurrentText: vi.fn(() => over.replyText ?? ''),
    hasVisibleProgress: vi.fn(() => over.hasVisibleProgress ?? false),
    closeTurnWithInteractiveDetection: vi.fn(async () => false),
    closeWithBubble: vi.fn(async (b: string) => {
      bubbles.push(b);
    }),
    closeAll: vi.fn(async () => undefined),
  };
  const history = {
    appendUserPrompt: vi.fn(),
    appendAgentReply: vi.fn(),
    flush: vi.fn(async () => undefined),
  };
  const relay = { sendResult: vi.fn(async () => undefined) };

  const session = {
    client,
    relay,
    acpSessionId: 'conv-1',
    streaming,
    opts,
    history,
    jsonlHistory: {},
    agentCaps: { loadSession: true },
    turnFiles: { flushTurn: vi.fn(async () => undefined), peekTurnPaths: vi.fn(() => []) },
    getBeads: () => null,
    publisher: { publishOutput: vi.fn(async () => undefined) },
    recentStderr: [],
    budgetRecovery: { offer: vi.fn(), tryRecover: vi.fn(async () => false) },
    budgetReachedFlag: { get: () => false, set: () => undefined },
    pendingProposal: { current: null },
  } as unknown as AcpSessionContext;

  return { session, client, streaming, history, relay, bubbles, opts };
}

describe('start_task — silent empty-turn detection', () => {
  it('an empty end_turn (no text, no visible progress) publishes the honest empty-reply bubble', async () => {
    const { session, client, streaming, history, relay, bubbles, opts } = makeCtx({
      agent: 'kimi',
      stopReason: 'end_turn',
      replyText: '',
      hasVisibleProgress: false,
    });

    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'do the thing' })),
    );

    expect(client.prompt).toHaveBeenCalledOnce();
    expect(streaming.closeWithBubble).toHaveBeenCalledOnce();
    expect(streaming.closeTurnWithInteractiveDetection).not.toHaveBeenCalled();
    const expected = emptyReplyMessage(opts.agent);
    expect(bubbles).toEqual([expected]);
    expect(expected).toContain('Kimi Code');
    expect(expected).toContain('kimi -p');
    expect(history.appendAgentReply).toHaveBeenCalledWith(expected);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'failed', {
      error: 'agent turn ended with an empty reply',
    });
  });

  it('a normal turn with real text closes normally — no bubble', async () => {
    const { session, streaming, relay, bubbles } = makeCtx({
      stopReason: 'end_turn',
      replyText: 'Here you go.',
      hasVisibleProgress: false,
    });

    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'do the thing' })),
    );

    expect(streaming.closeWithBubble).not.toHaveBeenCalled();
    expect(streaming.closeTurnWithInteractiveDetection).toHaveBeenCalledOnce();
    expect(bubbles).toEqual([]);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', { stopReason: 'end_turn' });
  });

  it('a tool-only turn (no chat text, but visible tool/thinking activity streamed) closes normally — no bubble', async () => {
    const { session, streaming, relay, bubbles } = makeCtx({
      stopReason: 'end_turn',
      replyText: '', // no assistant TEXT reply…
      hasVisibleProgress: true, // …but tool/thinking activity streamed
    });

    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'do the thing' })),
    );

    expect(streaming.closeWithBubble).not.toHaveBeenCalled();
    expect(streaming.closeTurnWithInteractiveDetection).toHaveBeenCalledOnce();
    expect(bubbles).toEqual([]);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', { stopReason: 'end_turn' });
  });

  it('a stopReason OTHER than end_turn with no content is left to the normal path (not misclassified as empty-reply)', async () => {
    const { session, streaming, relay, bubbles } = makeCtx({
      stopReason: 'max_turn_requests',
      replyText: '',
      hasVisibleProgress: false,
    });

    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'do the thing' })),
    );

    expect(streaming.closeWithBubble).not.toHaveBeenCalled();
    expect(streaming.closeTurnWithInteractiveDetection).toHaveBeenCalledOnce();
    expect(bubbles).toEqual([]);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', {
      stopReason: 'max_turn_requests',
    });
  });
});

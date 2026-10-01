/**
 * From-scratch sessions: a clean end of turn asks `maybeAutoOpenScratchPreview`
 * whether to open the Preview the agent did not open (RCA 2026-09-30 — a
 * managed agent built index.html and never called start_preview).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAutoOpen } = vi.hoisted(() => ({ mockAutoOpen: vi.fn(() => false) }));
vi.mock('../../../src/scratch/auto-preview', () => ({ maybeAutoOpenScratchPreview: mockAutoOpen }));

import {
  dispatchAcpCommand,
  assembleAcpCommandContext,
  type AcpSessionContext,
} from '../../../src/agents/acp/command-handlers';
import { agentPreviewBridge } from '../../../src/commands/start/agent-preview-bridge';
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

beforeEach(() => mockAutoOpen.mockClear());

describe('start_task — scratch auto-preview hook', () => {
  it('a clean end_turn asks the scratch auto-preview with this session and the agent bridge', async () => {
    const { session, relay } = makeCtx({ stopReason: 'end_turn', replyText: 'Done. Three files created.' });
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'build a page' })));
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', { stopReason: 'end_turn' });
    expect(mockAutoOpen).toHaveBeenCalledWith('s1', agentPreviewBridge);
  });

  it('a cancelled turn never opens it', async () => {
    const { session } = makeCtx({ stopReason: 'cancelled', replyText: 'partial' });
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'build a page' })));
    expect(mockAutoOpen).not.toHaveBeenCalled();
  });
});

/**
 * Agent Squad — `start_task.agentId` routing + prompt-prefix composition.
 *
 * The mobile @-mention sends the task with the MENTIONED agent's id. The
 * runner must swap onto that agent BEFORE the prompt runs (never answer with
 * the wrong agent), retry ONCE on the full credential/install path when the
 * fast path fails (an expired credential), and fail the task honestly rather
 * than silently running it on the current agent.
 *
 * The routed agent's first post-swap prompt carries, in this order:
 *   [team preamble?, delta briefing?, pending handoff?, ...user blocks]
 * — preamble only on that member's FIRST turn, briefing only when other
 * agents journaled turns it hasn't seen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  dispatchAcpCommand,
  assembleAcpCommandContext,
  type AcpSessionContext,
} from '../../../src/agents/acp/command-handlers';
import { SquadState } from '../../../src/agents/acp/squad-roster';
import type { RemoteCommand, SquadRosterData } from '@codeam/shared';

let homeDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-squad-'));
});
afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

const ROSTER: SquadRosterData = {
  agents: [
    { agentId: 'claude', displayName: 'Claude Code' },
    { agentId: 'codex', displayName: 'Codex CLI' },
  ],
  handoffsEnabled: false,
};

interface CtxOverrides {
  agent?: string;
  roster?: SquadRosterData | null;
  replyText?: string;
  routeResults?: Array<{ ok: boolean; agentId: string; error?: string }>;
  pendingHandoff?: { current: string | null };
  squad?: SquadState;
}

function makeCtx(over: CtxOverrides = {}) {
  const calls: string[] = [];
  const promptedBlocks: Array<Array<{ type: string; text?: string }>> = [];
  const replyText = over.replyText ?? 'All done.';
  const routeResults = [...(over.routeResults ?? [])];

  const client = {
    prompt: vi.fn(async (blocks: Array<{ type: string; text?: string }>) => {
      calls.push('prompt');
      promptedBlocks.push(blocks);
      return { stopReason: 'end_turn' };
    }),
    cancel: vi.fn(async () => undefined),
  };
  const relay = {
    sendResult: vi.fn(async (_id: string, status: string) => {
      calls.push(`ack:${status}`);
    }),
  };
  const streaming = {
    beginTurn: vi.fn(async () => undefined),
    getCurrentText: vi.fn(() => replyText),
    hasVisibleProgress: vi.fn(() => false),
    closeTurnWithInteractiveDetection: vi.fn(async () => false),
    closeWithBubble: vi.fn(async () => undefined),
    closeAll: vi.fn(async () => undefined),
  };
  const history = {
    appendUserPrompt: vi.fn(),
    appendAgentReply: vi.fn(),
    flush: vi.fn(async () => undefined),
  };
  const opts = { agent: over.agent ?? 'claude', sessionId: 's1', pluginId: 'p1' };
  const routeToAgent = vi.fn(async (agentId: string, o?: { skipFastPath?: boolean }) => {
    calls.push(`route:${agentId}${o?.skipFastPath ? ':full' : ':fast'}`);
    const next = routeResults.shift() ?? { ok: true, agentId };
    if (next.ok) opts.agent = agentId; // mirror the runner's swap of the live agent
    return next;
  });
  const squad = over.squad ?? new SquadState({ sessionId: 's1', homeDir });
  if (over.roster !== null) squad.roster = over.roster ?? ROSTER;
  const postSquadEvent = vi.fn(async (type: string, payload: Record<string, unknown>) => {
    calls.push(`event:${type}`);
    return { ok: true, type, payload };
  });

  const session = {
    client,
    relay,
    acpSessionId: 'conv-1',
    streaming,
    opts,
    history,
    jsonlHistory: {},
    agentCaps: { loadSession: true },
    turnFiles: { flushTurn: vi.fn(async () => undefined) },
    getBeads: () => null,
    publisher: { publishOutput: vi.fn(async () => undefined) },
    recentStderr: [],
    budgetRecovery: { offer: vi.fn(), tryRecover: vi.fn(async () => false) },
    budgetReachedFlag: { get: () => false, set: () => undefined },
    squad,
    routeToAgent,
    pendingProposal: { current: null },
    postSquadEvent,
    pendingHandoff: over.pendingHandoff,
  } as unknown as AcpSessionContext;

  return { session, calls, client, relay, routeToAgent, squad, postSquadEvent, promptedBlocks, opts };
}

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

/** Text of every prompt block, in order. */
function texts(blocks: Array<{ type: string; text?: string }>): string[] {
  return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '');
}

describe('start_task — agentId routing', () => {
  it('swaps onto the mentioned agent BEFORE prompting', async () => {
    const { session, calls, routeToAgent, client } = makeCtx();
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'fix the test', agentId: 'codex' })),
    );
    expect(routeToAgent).toHaveBeenCalledWith('codex');
    expect(client.prompt).toHaveBeenCalledOnce();
    expect(calls.indexOf('route:codex:fast')).toBeLessThan(calls.indexOf('prompt'));
    expect(calls).toContain('ack:completed');
  });

  it('does not route when the mentioned agent IS the current one', async () => {
    const { session, routeToAgent, client } = makeCtx();
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'go', agentId: 'claude' })),
    );
    expect(routeToAgent).not.toHaveBeenCalled();
    expect(client.prompt).toHaveBeenCalledOnce();
  });

  it('does not route when no agentId is present (the normal path)', async () => {
    const { session, routeToAgent, client } = makeCtx();
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'go' })));
    expect(routeToAgent).not.toHaveBeenCalled();
    expect(client.prompt).toHaveBeenCalledOnce();
  });

  it("fails honestly on an agent that isn't in the roster — never runs the prompt", async () => {
    const { session, routeToAgent, client, relay } = makeCtx();
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'go', agentId: 'ghost' })),
    );
    expect(routeToAgent).not.toHaveBeenCalled();
    expect(client.prompt).not.toHaveBeenCalled();
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'failed', {
      error: "Unknown agent 'ghost' — not in your squad.",
    });
  });

  it('retries ONCE on the full path when an armed fast path fails, then fails the task', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    // Member already brought up once this process → the fast path is armed.
    squad.member('codex').provisioned = true;
    squad.member('codex').binaryVerified = true;
    const { session, calls, routeToAgent, client, relay } = makeCtx({
      squad,
      routeResults: [
        { ok: false, agentId: 'codex', error: 'expired credential' },
        { ok: false, agentId: 'codex', error: 'expired credential' },
      ],
    });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'go', agentId: 'codex' })),
    );
    expect(routeToAgent).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['route:codex:fast', 'route:codex:full', 'ack:failed']);
    expect(client.prompt).not.toHaveBeenCalled();
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'failed', {
      error: 'expired credential',
    });
  });

  it('does NOT retry when the first attempt already ran the full sequence', async () => {
    // Fresh member (nothing armed) → performAgentSwitch already did everything;
    // a second identical attempt would just restart the adapter twice.
    const { session, routeToAgent, client } = makeCtx({
      routeResults: [{ ok: false, agentId: 'codex', error: 'no linked credential' }],
    });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'go', agentId: 'codex' })),
    );
    expect(routeToAgent).toHaveBeenCalledTimes(1);
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it('a recovered fast-path failure still runs the prompt on the routed agent', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    squad.member('codex').provisioned = true;
    const { session, calls, client } = makeCtx({
      squad,
      routeResults: [
        { ok: false, agentId: 'codex', error: 'expired credential' },
        { ok: true, agentId: 'codex' },
      ],
    });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'go', agentId: 'codex' })),
    );
    expect(client.prompt).toHaveBeenCalledOnce();
    expect(calls).toEqual(['route:codex:fast', 'route:codex:full', 'prompt', 'ack:completed']);
  });
});

describe('start_task — squad prompt prefixes', () => {
  it('prefixes the team preamble on a member FIRST turn only', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    const { session, promptedBlocks } = makeCtx({ squad });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'first' })),
    );
    expect(texts(promptedBlocks[0])[0]).toContain('[Team context]');

    // Second turn on the same agent: the member has journaled a turn, so no
    // preamble — and no briefing either (it authored the only entry).
    const second = makeCtx({ squad });
    await dispatchAcpCommand(
      assembleAcpCommandContext(second.session, startTask({ prompt: 'second' }, 'cmd-2')),
    );
    expect(texts(second.promptedBlocks[0])).toEqual(['second']);
  });

  it('composes preamble → briefing → handoff → user blocks, in that order', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    // Another agent already worked in this session — codex has seen none of it.
    squad.recordTurn({
      agentId: 'claude',
      prompt: 'refactor the parser',
      replySummary: 'done, split into two modules',
      filesTouched: ['src/parser.ts'],
    });
    const pendingHandoff = { current: '[Session handoff] context…' };
    const { session, promptedBlocks } = makeCtx({
      squad,
      agent: 'claude',
      pendingHandoff,
    });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'now the tests', agentId: 'codex' })),
    );
    const blockTexts = texts(promptedBlocks[0]);
    expect(blockTexts).toHaveLength(4);
    expect(blockTexts[0]).toContain('[Team context]');
    expect(blockTexts[1]).toContain('[Team update]');
    expect(blockTexts[1]).toContain('refactor the parser');
    expect(blockTexts[2]).toBe('[Session handoff] context…');
    expect(blockTexts[3]).toBe('now the tests');
    // One-shot: the handoff slot is consumed.
    expect(pendingHandoff.current).toBeNull();
  });

  it('no roster → no squad prefixes at all (old backend / offline)', async () => {
    const { session, promptedBlocks } = makeCtx({ roster: null });
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'hello' })));
    expect(texts(promptedBlocks[0])).toEqual(['hello']);
  });
});

describe('start_task — squad journal', () => {
  it('records the turn then advances the agent lastTurnIndex (never briefs itself)', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    const { session } = makeCtx({ squad, replyText: 'Fixed the flaky test.' });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'fix the flake' })),
    );
    expect(squad.turnCount()).toBe(1);
    expect(squad.member('claude').lastTurnIndex).toBe(1);
    const [entry] = squad.entriesSince(0);
    expect(entry).toMatchObject({
      agentId: 'claude',
      prompt: 'fix the flake',
      replySummary: 'Fixed the flaky test.',
    });
  });

  it('journals under the ROUTED agent, not the one the task started on', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    const { session } = makeCtx({ squad });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'go', agentId: 'codex' })),
    );
    expect(squad.entriesSince(0)[0]?.agentId).toBe('codex');
    expect(squad.member('codex').lastTurnIndex).toBe(1);
    expect(squad.member('claude').lastTurnIndex).toBe(0);
  });
});

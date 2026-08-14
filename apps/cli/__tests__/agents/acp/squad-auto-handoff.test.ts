/**
 * Agent Squad — P2-2: autonomous chained handoffs (PRO) + `squad_configure` /
 * `squad_stats`.
 *
 * Opt-in per session: a valid proposal at turn close is SELF-accepted (no
 * card), its prompt runs as the next turn on the target, and the chain repeats
 * while the hop budget lasts. Budget exhausted / mode off / FREE plan → the v1
 * tap-to-accept card flow, byte-for-byte unchanged.
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
import { makeConfig } from '../../../src/config';
import type { RemoteCommand, SquadRosterData } from '@codeam/shared';

let homeDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-squad-auto-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

const PRO_ROSTER: SquadRosterData = {
  agents: [
    { agentId: 'claude', displayName: 'Claude Code' },
    { agentId: 'codex', displayName: 'Codex CLI' },
    { agentId: 'gemini', displayName: 'Gemini CLI' },
  ],
  handoffsEnabled: true,
};

function fence(to: string, prompt = 'run the tests'): string {
  return [
    'Done.',
    '',
    '```codeam-handoff',
    JSON.stringify({ to, reason: 'better fit', prompt }),
    '```',
  ].join('\n');
}

interface Over {
  roster?: SquadRosterData;
  /** Reply text per prompt() call, in order; the last one repeats. */
  replies?: string[];
  squad?: SquadState;
  routeResults?: Array<{ ok: boolean; agentId: string; error?: string }>;
}

function makeCtx(over: Over = {}) {
  const events: Array<[string, Record<string, unknown>]> = [];
  const prompts: string[] = [];
  const replies = [...(over.replies ?? ['All done.'])];
  const routeResults = [...(over.routeResults ?? [])];
  let currentReply = 'All done.';

  const opts = { agent: 'claude', sessionId: 's1', pluginId: 'p1' };
  const makeClient = () => ({
    prompt: vi.fn(async (blocks: Array<{ type: string; text?: string }>) => {
      prompts.push(
        blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('\n'),
      );
      currentReply = replies.length > 1 ? (replies.shift() as string) : replies[0];
      return { stopReason: 'end_turn' };
    }),
    cancel: vi.fn(async () => undefined),
  });
  const client = makeClient();
  const clients = [client];
  const streaming = {
    beginTurn: vi.fn(async () => undefined),
    getCurrentText: vi.fn(() => currentReply),
    hasVisibleProgress: vi.fn(() => false),
    closeTurnWithInteractiveDetection: vi.fn(async () => false),
    closeWithBubble: vi.fn(async () => undefined),
    closeAll: vi.fn(async () => undefined),
  };
  const makeHistory = () => ({
    appendUserPrompt: vi.fn(),
    appendAgentReply: vi.fn(),
    flush: vi.fn(async () => undefined),
  });
  const history = makeHistory();
  const relay = { sendResult: vi.fn(async () => undefined) };

  const routeToAgent = vi.fn(async (agentId: string) => {
    const result = routeResults.shift() ?? { ok: true, agentId };
    const nextClient = makeClient();
    clients.push(nextClient);
    if (result.ok) opts.agent = agentId;
    return {
      ...result,
      result,
      handles: {
        client: nextClient,
        acpSessionId: `conv-${clients.length}`,
        history: makeHistory(),
        jsonlHistory: {},
        agentCaps: { loadSession: true },
        budgetRecovery: { offer: vi.fn(), tryRecover: vi.fn(async () => false) },
      },
    };
  });

  const squad = over.squad ?? new SquadState({ sessionId: 's1', homeDir });
  squad.roster = over.roster ?? PRO_ROSTER;

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
    squad,
    routeToAgent,
    pendingProposal: { current: null },
    postSquadEvent: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      events.push([type, payload]);
      return { ok: true };
    }),
  } as unknown as AcpSessionContext;

  return { session, squad, events, prompts, relay, routeToAgent, clients, opts };
}

function cmd(type: string, payload: Record<string, unknown>, id = 'cmd-1'): RemoteCommand {
  return {
    id,
    sessionId: 's1',
    pluginId: 'p1',
    type,
    payload,
    status: 'pending',
    createdAt: 0,
  } as unknown as RemoteCommand;
}

// ─── squad_configure ────────────────────────────────────────────────────────

describe('squad_configure', () => {
  it('persists the mode and acks the state AFTER the command', async () => {
    const { session, relay, squad } = makeCtx();
    await dispatchAcpCommand(
      assembleAcpCommandContext(
        session,
        cmd('squad_configure', { action: 'set', autoHandoffs: true, hopBudget: 5 }),
      ),
    );
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', {
      enabled: true,
      hopBudget: 5,
      hopsRemaining: 5,
    });
    expect(squad.auto).toEqual({ enabled: true, hopBudget: 5 });
  });

  it('CLAMPS an out-of-range budget rather than rejecting it', async () => {
    const { session, relay, squad } = makeCtx();
    await dispatchAcpCommand(
      assembleAcpCommandContext(
        session,
        cmd('squad_configure', { action: 'set', autoHandoffs: true, hopBudget: 99 }),
      ),
    );
    expect(squad.auto.hopBudget).toBe(10);
    await dispatchAcpCommand(
      assembleAcpCommandContext(
        session,
        cmd('squad_configure', { action: 'set', autoHandoffs: true, hopBudget: 0 }, 'cmd-2'),
      ),
    );
    expect(squad.auto.hopBudget).toBe(1);
  });

  it('defaults a missing budget to 3', async () => {
    const { session, squad } = makeCtx();
    await dispatchAcpCommand(
      assembleAcpCommandContext(
        session,
        cmd('squad_configure', { action: 'set', autoHandoffs: true }),
      ),
    );
    expect(squad.auto.hopBudget).toBe(3);
  });

  it('status reports the current mode + remaining budget', async () => {
    const { session, relay, squad } = makeCtx();
    squad.setAuto({ enabled: true, hopBudget: 2 });
    squad.consumeHop();
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, cmd('squad_configure', { action: 'status' })),
    );
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', {
      enabled: true,
      hopBudget: 2,
      hopsRemaining: 1,
    });
  });

  it('refuses an unknown action honestly', async () => {
    const { session, relay } = makeCtx();
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, cmd('squad_configure', { action: 'nope' })),
    );
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'failed', {
      error: 'squad_configure: unknown action',
    });
  });
});

describe('config.setSquadAuto', () => {
  it('clamps + round-trips through ~/.codeam/config.json', () => {
    const cfg = makeConfig(homeDir);
    cfg.addSession({
      id: 's1',
      pluginId: 'p1',
      userName: 'u',
      userEmail: 'e',
      plan: 'PRO',
      pairedAt: 1,
      agent: 'claude',
    });
    expect(cfg.setSquadAuto('p1', { enabled: true, hopBudget: 42 })).toEqual({
      enabled: true,
      hopBudget: 10,
    });
    expect(cfg.getSquadAuto('p1')).toEqual({ enabled: true, hopBudget: 10 });
    // A fresh reader (CLI restart) sees the same persisted value.
    expect(makeConfig(homeDir).getSquadAuto('p1')).toEqual({ enabled: true, hopBudget: 10 });
  });

  it('is a no-op for an unknown pluginId', () => {
    const cfg = makeConfig(homeDir);
    expect(cfg.setSquadAuto('ghost', { enabled: true, hopBudget: 3 })).toBeNull();
    expect(cfg.getSquadAuto('ghost')).toBeNull();
  });
});

// ─── the autonomous chain ───────────────────────────────────────────────────

describe('autonomous handoffs', () => {
  it('self-accepts, routes, and runs the proposal prompt — chaining until the budget runs out', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    squad.setAuto({ enabled: true, hopBudget: 2 });
    const { session, events, prompts, routeToAgent } = makeCtx({
      squad,
      replies: [fence('codex', 'fix the tests'), fence('gemini', 'analyse the logs'), 'All done.'],
    });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, cmd('start_task', { prompt: 'ship it' })),
    );

    // Three turns ran: the user's, then one per auto hop.
    expect(prompts).toEqual(['ship it', 'fix the tests', 'analyse the logs']);
    expect(routeToAgent.mock.calls.map((c) => c[0])).toEqual(['codex', 'gemini']);

    // Two auto proposals, each immediately self-resolved, in strict order.
    expect(events.map(([t]) => t)).toEqual([
      'handoff_proposed',
      'handoff_resolved',
      'handoff_proposed',
      'handoff_resolved',
    ]);
    expect(events[0]).toEqual([
      'handoff_proposed',
      expect.objectContaining({
        proposalId: 'hp-cmd-1',
        toAgentId: 'codex',
        auto: true,
        hopsRemaining: 2,
      }),
    ]);
    expect(events[1]).toEqual([
      'handoff_resolved',
      { proposalId: 'hp-cmd-1', accepted: true, auto: true },
    ]);
    // Hop 2 mints its own id from the command id + hop index (no clock).
    expect(events[2][1]).toMatchObject({
      proposalId: 'hp-cmd-1-h2',
      toAgentId: 'gemini',
      auto: true,
      hopsRemaining: 1,
    });
    expect(squad.hopsRemaining()).toBe(0);
  });

  it('falls back to the CARD once the budget is exhausted', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    squad.setAuto({ enabled: true, hopBudget: 1 });
    const { session, events, prompts } = makeCtx({
      squad,
      replies: [fence('codex', 'fix the tests'), fence('gemini', 'analyse the logs')],
    });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, cmd('start_task', { prompt: 'ship it' })),
    );

    expect(prompts).toEqual(['ship it', 'fix the tests']);
    // Hop 1 auto; the proposal from the auto turn has no budget left → card.
    expect(events.map(([t, p]) => [t, p.auto])).toEqual([
      ['handoff_proposed', true],
      ['handoff_resolved', true],
      ['handoff_proposed', undefined],
    ]);
    expect(session.pendingProposal?.current).toMatchObject({
      proposalId: 'hp-cmd-1-h2',
      toAgentId: 'gemini',
    });
  });

  it('a USER prompt RESETS the budget (and interrupts the chain)', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    squad.setAuto({ enabled: true, hopBudget: 1 });
    const first = makeCtx({ squad, replies: [fence('codex'), 'All done.'] });
    await dispatchAcpCommand(
      assembleAcpCommandContext(first.session, cmd('start_task', { prompt: 'ship it' })),
    );
    expect(squad.hopsRemaining()).toBe(0);

    const second = makeCtx({ squad, replies: ['All done.'] });
    await dispatchAcpCommand(
      assembleAcpCommandContext(
        second.session,
        cmd('start_task', { prompt: 'next thing' }, 'cmd-2'),
      ),
    );
    expect(squad.hopsRemaining()).toBe(1);
  });

  it('mode OFF → the v1 card flow, no self-accept', async () => {
    const { session, events, prompts, routeToAgent } = makeCtx({ replies: [fence('codex')] });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, cmd('start_task', { prompt: 'ship it' })),
    );
    expect(prompts).toEqual(['ship it']);
    expect(routeToAgent).not.toHaveBeenCalled();
    expect(events.map(([t]) => t)).toEqual(['handoff_proposed']);
    // The additive `auto` field is ABSENT (not `false`) on the v1 card flow.
    expect(events[0][1]).not.toHaveProperty('auto');
    expect(events[0][1]).not.toHaveProperty('hopsRemaining');
    expect(session.pendingProposal?.current).toMatchObject({ proposalId: 'hp-cmd-1' });
  });

  it('FREE plan (handoffsEnabled false) → nothing fires even with the mode ON', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    squad.setAuto({ enabled: true, hopBudget: 3 });
    const { session, events, routeToAgent } = makeCtx({
      squad,
      roster: { ...PRO_ROSTER, handoffsEnabled: false },
      replies: [fence('codex')],
    });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, cmd('start_task', { prompt: 'ship it' })),
    );
    expect(events).toEqual([]);
    expect(routeToAgent).not.toHaveBeenCalled();
  });

  it('a failed auto route ends the chain honestly — the delivered reply still acks', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    squad.setAuto({ enabled: true, hopBudget: 3 });
    const { session, prompts, relay } = makeCtx({
      squad,
      replies: [fence('codex')],
      routeResults: [{ ok: false, agentId: 'codex', error: 'expired credential' }],
    });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, cmd('start_task', { prompt: 'ship it' })),
    );
    expect(prompts).toEqual(['ship it']);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', {
      stopReason: 'end_turn',
    });
  });

  it('journals every turn of the chain under the agent that ran it', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    squad.setAuto({ enabled: true, hopBudget: 2 });
    const { session } = makeCtx({
      squad,
      replies: [fence('codex', 'fix the tests'), 'Tests green.'],
    });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, cmd('start_task', { prompt: 'ship it' })),
    );
    expect(squad.entriesSince(0)).toMatchObject([
      { agentId: 'claude', prompt: 'ship it' },
      { agentId: 'codex', prompt: 'fix the tests', replySummary: 'Tests green.' },
    ]);
  });
});

// ─── squad_stats ────────────────────────────────────────────────────────────

describe('squad_stats', () => {
  it('reports per-member turns + DISTINCT files, and the handoff counters', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    squad.setAuto({ enabled: true, hopBudget: 2 });
    const { session, relay } = makeCtx({
      squad,
      replies: [fence('codex', 'fix the tests'), 'Tests green.'],
    });
    // One user turn + one auto hop, then ask for the stats.
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, cmd('start_task', { prompt: 'ship it' })),
    );
    await dispatchAcpCommand(assembleAcpCommandContext(session, cmd('squad_stats', {}, 'cmd-2')));

    expect(relay.sendResult).toHaveBeenLastCalledWith('cmd-2', 'completed', {
      members: [
        { agentId: 'claude', turns: 1, filesTouched: 0 },
        { agentId: 'codex', turns: 1, filesTouched: 0 },
      ],
      handoffs: { proposed: 1, accepted: 1, auto: 1 },
      sinceTurn: 1,
    });
  });

  it('counts a file touched across several turns ONCE', () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    squad.recordTurn({
      agentId: 'claude',
      prompt: 'a',
      replySummary: 'a',
      filesTouched: ['src/x.ts', 'src/y.ts'],
    });
    squad.recordTurn({
      agentId: 'claude',
      prompt: 'b',
      replySummary: 'b',
      filesTouched: ['src/x.ts'],
    });
    expect(squad.stats().members).toEqual([{ agentId: 'claude', turns: 2, filesTouched: 2 }]);
  });
});

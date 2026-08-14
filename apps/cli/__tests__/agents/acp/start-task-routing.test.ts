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
  turnFilesPeek?: string[];
}

function makeCtx(over: CtxOverrides = {}) {
  const calls: string[] = [];
  const promptedBlocks: Array<Array<{ type: string; text?: string }>> = [];
  const replyText = over.replyText ?? 'All done.';
  const routeResults = [...(over.routeResults ?? [])];

  /**
   * A swap REPLACES the client: `relaunchWith` stops the old adapter — which
   * nulls its connection + session id — and spawns a new one. So the fake
   * models a real AcpClient: once stopped, `prompt` throws exactly what the
   * SDK-backed client throws, and the routed turn MUST land on the new
   * instance. (A fake that only mutated `opts.agent` hid the real bug.)
   */
  const makeClient = (label: string) => {
    let stopped = false;
    return {
      label,
      stop: () => {
        stopped = true;
      },
      prompt: vi.fn(async (blocks: Array<{ type: string; text?: string }>) => {
        if (stopped) throw new Error('AcpClient.prompt called before start()');
        calls.push(`prompt@${label}`);
        promptedBlocks.push(blocks);
        return { stopReason: 'end_turn' };
      }),
      cancel: vi.fn(async () => undefined),
    };
  };
  const makeHistory = (label: string) => ({
    label,
    appendUserPrompt: vi.fn(),
    appendAgentReply: vi.fn(),
    flush: vi.fn(async () => undefined),
  });

  const client = makeClient('claude');
  /** Every client/history the fake swap has produced, oldest first. */
  const clients = [client];
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
  const history = makeHistory('claude');
  const histories = [history];
  const opts = { agent: over.agent ?? 'claude', sessionId: 's1', pluginId: 'p1' };
  /**
   * Mirrors `runAcpSession`'s `routeToAgent` faithfully: it tears the old
   * adapter down and hands back the POST-SWAP handles the caller must rebind
   * onto its (snapshot) command context — on failure too, since the revert
   * relaunches the prior agent and replaces the same handles.
   */
  const routeToAgent = vi.fn(async (agentId: string, o?: { skipFastPath?: boolean }) => {
    calls.push(`route:${agentId}${o?.skipFastPath ? ':full' : ':fast'}`);
    const result = routeResults.shift() ?? { ok: true, agentId };
    // Both the swap and its revert stop the running client and spawn a new one.
    clients[clients.length - 1].stop();
    const nextAgent = result.ok ? agentId : opts.agent;
    const nextClient = makeClient(nextAgent);
    const nextHistory = makeHistory(nextAgent);
    clients.push(nextClient);
    histories.push(nextHistory);
    if (result.ok) opts.agent = agentId;
    return {
      // Spread the SwitchAgentResult alongside the outcome so this fake also
      // satisfies the pre-rebind contract (`{ok, agentId, error}`). That's
      // what makes the tests below a regression guard for the STALE-HANDLE
      // bug specifically — against the old handler they get past the route
      // and then prompt the stopped client, exactly as production did.
      ...result,
      result,
      handles: {
        client: nextClient,
        acpSessionId: `conv-${clients.length}`,
        history: nextHistory,
        jsonlHistory: {},
        agentCaps: { loadSession: true },
        budgetRecovery: { offer: vi.fn(), tryRecover: vi.fn(async () => false) },
      },
    };
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
    turnFiles: {
      flushTurn: vi.fn(async () => undefined),
      peekTurnPaths: vi.fn(() => over.turnFilesPeek ?? []),
    },
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

  return {
    session,
    calls,
    client,
    clients,
    history,
    histories,
    relay,
    routeToAgent,
    squad,
    postSquadEvent,
    promptedBlocks,
    opts,
  };
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
    const { session, calls, routeToAgent, clients } = makeCtx();
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'fix the test', agentId: 'codex' })),
    );
    expect(routeToAgent).toHaveBeenCalledWith('codex');
    expect(calls.indexOf('route:codex:fast')).toBeLessThan(calls.indexOf('prompt@codex'));
    expect(calls).toContain('ack:completed');
  });

  it('prompts the POST-SWAP client, never the one the swap stopped', async () => {
    // The command context is a `{...session, cmd}` SNAPSHOT: without rebinding
    // it to the runner's new handles, this turn talks to the stopped adapter
    // and dies with "AcpClient.prompt called before start()".
    const { session, clients, histories, relay } = makeCtx();
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'fix the test', agentId: 'codex' })),
    );
    const [stopped, live] = clients;
    expect(clients).toHaveLength(2);
    expect(stopped.prompt).not.toHaveBeenCalled();
    expect(live.prompt).toHaveBeenCalledOnce();
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', {
      stopReason: 'end_turn',
    });
    // …and the conversation is recorded in the NEW agent's accumulator, not
    // the discarded one.
    const [discarded, current] = histories;
    expect(discarded.appendUserPrompt).not.toHaveBeenCalled();
    expect(discarded.appendAgentReply).not.toHaveBeenCalled();
    expect(current.appendUserPrompt).toHaveBeenCalledWith('fix the test');
    expect(current.appendAgentReply).toHaveBeenCalledWith('All done.');
  });

  it('rebinds again after the full-path retry (the SECOND new client prompts)', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    squad.member('codex').provisioned = true;
    const { session, clients } = makeCtx({
      squad,
      routeResults: [
        { ok: false, agentId: 'codex', error: 'expired credential' },
        { ok: true, agentId: 'codex' },
      ],
    });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'go', agentId: 'codex' })),
    );
    expect(clients).toHaveLength(3); // original + revert + retry
    expect(clients[0].prompt).not.toHaveBeenCalled();
    expect(clients[1].prompt).not.toHaveBeenCalled();
    expect(clients[2].prompt).toHaveBeenCalledOnce();
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
    const { session, calls, clients } = makeCtx({
      squad,
      routeResults: [
        { ok: false, agentId: 'codex', error: 'expired credential' },
        { ok: true, agentId: 'codex' },
      ],
    });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'go', agentId: 'codex' })),
    );
    expect(clients.at(-1)?.prompt).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      'route:codex:fast',
      'route:codex:full',
      'prompt@codex',
      'ack:completed',
    ]);
  });
});

describe('start_task — squad prompt prefixes', () => {
  it('prefixes the team preamble on a member FIRST turn only', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    const { session, promptedBlocks } = makeCtx({ squad });
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'first' })));
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

  it("after a CLI restart, a journal of only the CURRENT agent's own turns injects NO briefing", async () => {
    // Simulate the restart: one SquadState instance records claude's turn and
    // persists it to disk, then a SECOND instance (fresh process) reloads the
    // journal — its per-member lastTurnIndex resets to 0 in memory even
    // though the journal itself is non-empty.
    const journalSquad = new SquadState({ sessionId: 's1', homeDir });
    journalSquad.recordTurn({
      agentId: 'claude',
      prompt: 'refactor the parser',
      replySummary: 'done, split into two modules',
      filesTouched: ['src/parser.ts'],
    });
    const restarted = new SquadState({ sessionId: 's1', homeDir });
    const { session, promptedBlocks } = makeCtx({ squad: restarted, agent: 'claude' });
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'continue' })));
    const blockTexts = texts(promptedBlocks[0]);
    expect(blockTexts.some((t) => t.includes('[Team update]'))).toBe(false);
  });

  it("after a CLI restart, a MIXED journal briefs only the OTHER agent's entries", async () => {
    const journalSquad = new SquadState({ sessionId: 's1', homeDir });
    journalSquad.recordTurn({
      agentId: 'claude',
      prompt: 'wrote the parser',
      replySummary: 'parser done',
      filesTouched: ['src/parser.ts'],
    });
    journalSquad.recordTurn({
      agentId: 'codex',
      prompt: 'wrote tests',
      replySummary: 'tests added',
      filesTouched: ['src/parser.test.ts'],
    });
    const restarted = new SquadState({ sessionId: 's1', homeDir });
    const { session, promptedBlocks } = makeCtx({ squad: restarted, agent: 'codex' });
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'continue' })));
    const blockTexts = texts(promptedBlocks[0]);
    const briefing = blockTexts.find((t) => t.includes('[Team update]'));
    expect(briefing).toBeDefined();
    expect(briefing).toContain('wrote the parser');
    expect(briefing).not.toContain('wrote tests');
  });
});

// ─── Agent-proposed handoffs (detect → emit → resolve) ─────────────────────

const HANDOFF_ROSTER: SquadRosterData = { ...ROSTER, handoffsEnabled: true };

function fenceReply(to: string, reason = 'better suited', prompt = 'run the tests'): string {
  return [
    "Here's what I found.",
    '',
    '```codeam-handoff',
    JSON.stringify({ to, reason, prompt }),
    '```',
  ].join('\n');
}

/** Every ('type', payload) pair the serialized squad emitter received. */
function events(
  postSquadEvent: ReturnType<typeof vi.fn>,
): Array<[string, Record<string, unknown>]> {
  return postSquadEvent.mock.calls as Array<[string, Record<string, unknown>]>;
}

describe('start_task — agent-proposed handoffs', () => {
  it('emits handoff_proposed once, on the binding wire shape, and opens the slot', async () => {
    const { session, postSquadEvent } = makeCtx({
      roster: HANDOFF_ROSTER,
      replyText: fenceReply('codex', 'codex is faster at tests', 'fix the failing suite'),
    });
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'ship it' })));

    expect(events(postSquadEvent)).toEqual([
      [
        'handoff_proposed',
        {
          proposalId: 'hp-cmd-1',
          fromAgentId: 'claude',
          toAgentId: 'codex',
          reason: 'codex is faster at tests',
          prompt: 'fix the failing suite',
        },
      ],
    ]);
    expect(session.pendingProposal?.current).toMatchObject({
      proposalId: 'hp-cmd-1',
      toAgentId: 'codex',
    });
  });

  it('keeps the fence out of the durable reply AND the journal', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    const { session } = makeCtx({
      squad,
      roster: HANDOFF_ROSTER,
      replyText: fenceReply('codex'),
    });
    const history = session.history as unknown as { appendAgentReply: ReturnType<typeof vi.fn> };
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'ship it' })));

    const durable = history.appendAgentReply.mock.calls[0][0] as string;
    expect(durable).toBe("Here's what I found.");
    expect(squad.entriesSince(0)[0]?.replySummary).toBe("Here's what I found.");
  });

  it('handoffsEnabled false → fence still stripped, NO event', async () => {
    const { session, postSquadEvent } = makeCtx({ replyText: fenceReply('codex') });
    const history = session.history as unknown as { appendAgentReply: ReturnType<typeof vi.fn> };
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'ship it' })));

    expect(postSquadEvent).not.toHaveBeenCalled();
    expect(session.pendingProposal?.current).toBeNull();
    expect(history.appendAgentReply.mock.calls[0][0]).toBe("Here's what I found.");
  });

  it('routing the next task to the proposed agent resolves it ACCEPTED', async () => {
    const { session, postSquadEvent } = makeCtx({
      roster: HANDOFF_ROSTER,
      replyText: fenceReply('codex'),
    });
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'ship it' })));
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'go', agentId: 'codex' }, 'cmd-2')),
    );

    const resolved = events(postSquadEvent).filter(([t]) => t === 'handoff_resolved');
    expect(resolved).toEqual([['handoff_resolved', { proposalId: 'hp-cmd-1', accepted: true }]]);
    expect(session.pendingProposal?.current).toBeNull();
  });

  it('any other prompt resolves it DECLINED', async () => {
    const { session, postSquadEvent } = makeCtx({
      roster: HANDOFF_ROSTER,
      replyText: fenceReply('codex'),
    });
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'ship it' })));
    // No agentId — the user simply carried on with the current agent. (The
    // second reply carries no fence, so nothing new is proposed.)
    (session.streaming.getCurrentText as ReturnType<typeof vi.fn>).mockReturnValue('ok');
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'no, keep going' }, 'cmd-2')),
    );

    expect(events(postSquadEvent)).toEqual([
      ['handoff_proposed', expect.objectContaining({ proposalId: 'hp-cmd-1' })],
      ['handoff_resolved', { proposalId: 'hp-cmd-1', accepted: false }],
    ]);
    expect(session.pendingProposal?.current).toBeNull();
  });

  it('drops a SECOND proposal while one is still pending (max one open card)', async () => {
    const { session, postSquadEvent, client } = makeCtx({
      roster: HANDOFF_ROSTER,
      replyText: fenceReply('codex'),
    });
    // Two turns in flight at once: both resolve nothing at their (empty) start,
    // then close in order — the second must find the slot already taken. The
    // staggered prompt keeps the interleaving deterministic.
    let n = 0;
    (client.prompt as ReturnType<typeof vi.fn>).mockImplementation(
      async () =>
        new Promise((resolve) => setTimeout(() => resolve({ stopReason: 'end_turn' }), (n += 10))),
    );
    await Promise.all([
      dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'a' }, 'cmd-a'))),
      dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'b' }, 'cmd-b'))),
    ]);

    expect(events(postSquadEvent).filter(([t]) => t === 'handoff_proposed')).toHaveLength(1);
    expect(session.pendingProposal?.current?.proposalId).toBe('hp-cmd-a');
  });

  it('ignores a fence naming an agent outside the roster', async () => {
    const { session, postSquadEvent } = makeCtx({
      roster: HANDOFF_ROSTER,
      replyText: fenceReply('ghost'),
    });
    const history = session.history as unknown as { appendAgentReply: ReturnType<typeof vi.fn> };
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'ship it' })));

    expect(postSquadEvent).not.toHaveBeenCalled();
    // …but the litter is still stripped from what the user sees.
    expect(history.appendAgentReply.mock.calls[0][0]).toBe("Here's what I found.");
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

  it('captures a non-empty filesTouched from the aggregator peek', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    const { session } = makeCtx({
      squad,
      replyText: 'Refactored the parser.',
      turnFilesPeek: ['src/parser.ts', 'src/parser.test.ts'],
    });
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: 'refactor the parser' })),
    );
    const [entry] = squad.entriesSince(0);
    expect(entry?.filesTouched).toEqual(['src/parser.ts', 'src/parser.test.ts']);
  });

  it('caps filesTouched at 20 paths', async () => {
    const squad = new SquadState({ sessionId: 's1', homeDir });
    const many = Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`);
    const { session } = makeCtx({ squad, turnFilesPeek: many });
    await dispatchAcpCommand(assembleAcpCommandContext(session, startTask({ prompt: 'go' })));
    const [entry] = squad.entriesSince(0);
    expect(entry?.filesTouched).toHaveLength(20);
    expect(entry?.filesTouched).toEqual(many.slice(0, 20));
  });
});

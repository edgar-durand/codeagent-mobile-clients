/**
 * Agent Squad P2-1 — `@coderabbit` one-shot review mentions.
 *
 * CodeRabbit has no ACP adapter and its runtime is a `BatchAgentStrategy`, so a
 * mention can NEVER be a swap. It runs the existing batch review as a synthetic
 * turn inside the current session: the user's words echo as theirs, the review
 * publishes as ONE turn attributed to `coderabbit` (and is journaled under it),
 * and the resident agent is untouched from start to finish.
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
import {
  CODERABBIT_NOT_LINKED_MESSAGE,
  CODERABBIT_NO_CUSTOM_INSTRUCTIONS_NOTICE,
  composeReviewOutput,
  hasCustomInstructions,
  runCoderabbitMentionReview,
} from '../../../src/agents/acp/coderabbit-mention';
import { resolveSwitchTarget } from '../../../src/agents/acp/switch-agent';
import { SquadState } from '../../../src/agents/acp/squad-roster';
import { AcpHistory } from '../../../src/agents/acp/runner';
import type { AcpPublisher } from '../../../src/agents/acp/publisher';
import * as pairing from '../../../src/services/pairing.service';
import * as coderabbitConfigure from '../../../src/agents/coderabbit/configure';
import type { RemoteCommand, SquadRosterData } from '@codeam/shared';
import type { CoderabbitConfigureResult } from '../../../src/agents/coderabbit/configure';

let homeDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-cr-mention-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

/** Roster WITHOUT coderabbit — the backend only lists switch-capable agents,
 *  and the mention must work anyway. */
const ROSTER: SquadRosterData = {
  agents: [
    { agentId: 'claude', displayName: 'Claude Code' },
    { agentId: 'codex', displayName: 'Codex CLI' },
  ],
  handoffsEnabled: true,
};

function result(over: Partial<CoderabbitConfigureResult> = {}): CoderabbitConfigureResult {
  return { action: 'status', supported: true, installed: true, loggedIn: true, ...over };
}

function makeCtx(over: { squad?: SquadState } = {}) {
  const opts = {
    agent: 'claude',
    sessionId: 's1',
    pluginId: 'p1',
    pluginAuthToken: 'tok',
  };
  const client = { prompt: vi.fn(async () => ({ stopReason: 'end_turn' })), cancel: vi.fn() };
  const bubbles: string[] = [];
  const streaming = {
    beginTurn: vi.fn(async () => undefined),
    getCurrentText: vi.fn(() => ''),
    hasVisibleProgress: vi.fn(() => false),
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
  const routeToAgent = vi.fn();
  const squad = over.squad ?? new SquadState({ sessionId: 's1', homeDir });
  squad.roster = ROSTER;

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
    postSquadEvent: vi.fn(async () => ({ ok: true })),
  } as unknown as AcpSessionContext;

  return { session, squad, client, streaming, history, relay, routeToAgent, bubbles, opts };
}

function startTask(payload: Record<string, unknown>, id = 'cmd-1'): RemoteCommand {
  return {
    id,
    sessionId: 's1',
    pluginId: 'p1',
    type: 'start_task',
    payload,
    status: 'pending',
    createdAt: 0,
  } as unknown as RemoteCommand;
}

/** Stub the reviewer orchestration: logged in, and `review` returns `markdown`. */
function stubReviewer(markdown: string): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(coderabbitConfigure, 'configureCoderabbit')
    .mockImplementation(async (input) =>
      input.action === 'review'
        ? result({ action: 'review', review: { markdown } })
        : result({ action: input.action }),
    ) as ReturnType<typeof vi.spyOn>;
}

// ─── pure helpers ───────────────────────────────────────────────────────────

describe('hasCustomInstructions', () => {
  it('is false for a bare mention (with or without the literal token)', () => {
    expect(hasCustomInstructions('@coderabbit')).toBe(false);
    expect(hasCustomInstructions('  @coderabbit  ')).toBe(false);
    expect(hasCustomInstructions('')).toBe(false);
  });

  it('is true once the user typed anything else', () => {
    expect(hasCustomInstructions('@coderabbit focus on the auth module')).toBe(true);
    expect(hasCustomInstructions('review the parser please')).toBe(true);
  });
});

describe('composeReviewOutput', () => {
  it('prepends the notice ONLY when custom instructions were given', () => {
    expect(composeReviewOutput('## Findings', false)).toBe('## Findings');
    expect(composeReviewOutput('## Findings', true)).toBe(
      `${CODERABBIT_NO_CUSTOM_INSTRUCTIONS_NOTICE}\n\n## Findings`,
    );
  });

  it('never publishes an empty turn', () => {
    expect(composeReviewOutput('   ', false)).toBe('CodeRabbit found no issues to report.');
  });
});

describe('runCoderabbitMentionReview', () => {
  it('refuses honestly when nothing is vaulted', async () => {
    vi.spyOn(coderabbitConfigure, 'configureCoderabbit').mockResolvedValue(
      result({ loggedIn: false }),
    );
    const r = await runCoderabbitMentionReview({ fetchCredential: async () => null });
    expect(r).toEqual({ ok: false, error: CODERABBIT_NOT_LINKED_MESSAGE });
  });

  it('provisions from the vault when the box is not logged in yet', async () => {
    const configure = vi
      .spyOn(coderabbitConfigure, 'configureCoderabbit')
      .mockImplementation(async (input) => {
        if (input.action === 'status') return result({ loggedIn: false });
        if (input.action === 'provision') return result({ action: 'provision', loggedIn: true });
        return result({ action: 'review', review: { markdown: '## All good' } });
      });
    const r = await runCoderabbitMentionReview({
      fetchCredential: async () => ({ method: 'oauth', credential: 'blob' }),
    });
    expect(r).toEqual({ ok: true, markdown: '## All good' });
    expect(configure.mock.calls.map((c) => c[0].action)).toEqual(['status', 'provision', 'review']);
  });

  it('surfaces a review error verbatim', async () => {
    vi.spyOn(coderabbitConfigure, 'configureCoderabbit').mockImplementation(async (input) =>
      input.action === 'review'
        ? result({ action: 'review', error: "CodeRabbit's review service didn't respond in time" })
        : result({ action: input.action }),
    );
    const r = await runCoderabbitMentionReview();
    expect(r).toEqual({
      ok: false,
      error: "CodeRabbit's review service didn't respond in time",
    });
  });

  it('never throws — a spawn failure comes back as an honest error', async () => {
    vi.spyOn(coderabbitConfigure, 'configureCoderabbit').mockRejectedValue(new Error('ENOENT'));
    await expect(runCoderabbitMentionReview()).resolves.toEqual({ ok: false, error: 'ENOENT' });
  });
});

// ─── the routed start_task ──────────────────────────────────────────────────

describe('start_task — @coderabbit mention', () => {
  it('runs the review WITHOUT swapping, attributes the turn, and journals it', async () => {
    stubReviewer('## Findings\n- nit: rename `x`');
    vi.spyOn(pairing, 'fetchProvisionCredential').mockResolvedValue({
      method: 'oauth',
      credential: 'blob',
    });
    const { session, squad, routeToAgent, client, history, relay, bubbles, opts } = makeCtx();

    await dispatchAcpCommand(
      assembleAcpCommandContext(
        session,
        startTask({ prompt: '@coderabbit', agentId: 'coderabbit' }),
      ),
    );

    // NO swap happened: the resident agent is untouched and never prompted.
    expect(routeToAgent).not.toHaveBeenCalled();
    expect(client.prompt).not.toHaveBeenCalled();
    expect(opts.agent).toBe('claude');

    // The user's words are theirs; the review is ONE turn attributed to coderabbit.
    expect(history.appendUserPrompt).toHaveBeenCalledWith('@coderabbit');
    expect(history.appendAgentReply).toHaveBeenCalledWith(
      '## Findings\n- nit: rename `x`',
      'coderabbit',
    );
    expect(bubbles).toEqual(['## Findings\n- nit: rename `x`']);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', {
      agentId: 'coderabbit',
    });

    // Journaled under coderabbit — and the resident agent still owes itself a
    // briefing about it (its lastTurnIndex must NOT advance).
    expect(squad.entriesSince(0)).toMatchObject([{ agentId: 'coderabbit', prompt: '@coderabbit' }]);
    expect(squad.member('claude').lastTurnIndex).toBe(0);
  });

  it('a BARE mention records the mention itself — never an empty user prompt', async () => {
    stubReviewer('## Findings');
    vi.spyOn(pairing, 'fetchProvisionCredential').mockResolvedValue({
      method: 'oauth',
      credential: 'blob',
    });
    // Mobile lifts `@coderabbit` out of the text, so the prompt arrives EMPTY.
    const { session, history, squad } = makeCtx();
    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: '', agentId: 'coderabbit' })),
    );
    expect(history.appendUserPrompt).toHaveBeenCalledWith('@coderabbit');
    expect(squad.entriesSince(0)[0]?.prompt).toBe('@coderabbit');
  });

  it('a BARE mention leaves the session summary usable (not latched blank)', async () => {
    stubReviewer('## Findings');
    vi.spyOn(pairing, 'fetchProvisionCredential').mockResolvedValue({
      method: 'oauth',
      credential: 'blob',
    });
    // A REAL AcpHistory: `summary` is derived from the FIRST user prompt and
    // never re-derived, so an empty one would blank the RECENT row forever.
    const pushSessionList = vi.fn(
      async (_a: { sessions: Array<{ summary: string }> }) => undefined,
    );
    const publisher = {
      pushSessionList,
      pushConversation: vi.fn(async () => undefined),
    } as unknown as AcpPublisher;
    const { session } = makeCtx();
    session.history = new AcpHistory(publisher, { agent: 'claude', acpSessionId: 'conv-1' });

    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: '', agentId: 'coderabbit' })),
    );
    await session.history.flush();
    expect(pushSessionList).toHaveBeenCalled();
    expect(pushSessionList.mock.calls[0][0].sessions[0].summary).toBe('@coderabbit');
  });

  it('works even though the roster does NOT list coderabbit', async () => {
    stubReviewer('## Findings');
    vi.spyOn(pairing, 'fetchProvisionCredential').mockResolvedValue({
      method: 'oauth',
      credential: 'blob',
    });
    const { session, relay, squad } = makeCtx();
    expect(squad.roster?.agents.some((a) => a.agentId === 'coderabbit')).toBe(false);

    await dispatchAcpCommand(
      assembleAcpCommandContext(session, startTask({ prompt: '', agentId: 'coderabbit' })),
    );
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', {
      agentId: 'coderabbit',
    });
  });

  it('prepends the honest notice when the user typed extra instructions', async () => {
    stubReviewer('## Findings');
    vi.spyOn(pairing, 'fetchProvisionCredential').mockResolvedValue({
      method: 'oauth',
      credential: 'blob',
    });
    const { session, bubbles } = makeCtx();

    await dispatchAcpCommand(
      assembleAcpCommandContext(
        session,
        startTask({ prompt: '@coderabbit focus on the auth module', agentId: 'coderabbit' }),
      ),
    );
    expect(bubbles).toEqual([`${CODERABBIT_NO_CUSTOM_INSTRUCTIONS_NOTICE}\n\n## Findings`]);
  });

  it('does NOT prepend the notice for a bare mention', async () => {
    stubReviewer('## Findings');
    vi.spyOn(pairing, 'fetchProvisionCredential').mockResolvedValue({
      method: 'oauth',
      credential: 'blob',
    });
    const { session, bubbles } = makeCtx();
    await dispatchAcpCommand(
      assembleAcpCommandContext(
        session,
        startTask({ prompt: '@coderabbit', agentId: 'coderabbit' }),
      ),
    );
    expect(bubbles).toEqual(['## Findings']);
  });

  it('unlinked → honest failure, session untouched', async () => {
    vi.spyOn(coderabbitConfigure, 'configureCoderabbit').mockResolvedValue(
      result({ loggedIn: false }),
    );
    vi.spyOn(pairing, 'fetchProvisionCredential').mockResolvedValue(null);
    const { session, relay, bubbles, routeToAgent, client, squad, opts } = makeCtx();

    await dispatchAcpCommand(
      assembleAcpCommandContext(
        session,
        startTask({ prompt: '@coderabbit', agentId: 'coderabbit' }),
      ),
    );

    expect(bubbles).toEqual([CODERABBIT_NOT_LINKED_MESSAGE]);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'failed', {
      error: CODERABBIT_NOT_LINKED_MESSAGE,
    });
    expect(routeToAgent).not.toHaveBeenCalled();
    expect(client.prompt).not.toHaveBeenCalled();
    expect(opts.agent).toBe('claude');
    // A refusal is not a turn — nothing enters the shared journal.
    expect(squad.turnCount()).toBe(0);
  });

  it('a failed review acks honestly and leaves the resident agent running', async () => {
    vi.spyOn(coderabbitConfigure, 'configureCoderabbit').mockImplementation(async (input) =>
      input.action === 'review'
        ? result({ action: 'review', error: 'CodeRabbit CLI could not be installed' })
        : result({ action: input.action }),
    );
    const { session, relay, bubbles, opts, client } = makeCtx();

    await dispatchAcpCommand(
      assembleAcpCommandContext(
        session,
        startTask({ prompt: '@coderabbit', agentId: 'coderabbit' }),
      ),
    );

    expect(bubbles).toEqual(['CodeRabbit CLI could not be installed']);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'failed', {
      error: 'CodeRabbit CLI could not be installed',
    });
    expect(opts.agent).toBe('claude');
    expect(client.prompt).not.toHaveBeenCalled();
  });
});

describe('switch_agent still refuses coderabbit', () => {
  it('a mention-only reviewer can never become the session agent', () => {
    expect(resolveSwitchTarget('coderabbit', 'claude')).toEqual({
      ok: false,
      error: "CodeRabbit is a reviewer — it can't drive a session.",
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { AcpHistory, pickLatestResumableConversation } from '../../../src/agents/acp/runner';
import { AcpClient } from '../../../src/agents/acp/client';
import type { AcpClientOptions } from '../../../src/agents/acp/client';

/**
 * Agent-agnostic RECENT list (2026-07-16). The mobile Conversations sheet used to
 * show only ONE conversation: flush() pushed just the current session, and the
 * backend SET-replaces the list, so every turn clobbered the rest. The fix pushes
 * the FULL list enumerated via the ACP `session/list` RPC (any adapter advertising
 * sessionCapabilities.list — claude/codex/gemini), no per-agent JSONL scanning.
 */

type ListRow = { id: string; summary: string; timestamp: number };
function makePublisher() {
  return {
    pushSessionList: vi.fn(async (_arg: { agentId: string; sessions: ListRow[] }) => undefined),
    pushConversation: vi.fn(async (_arg: unknown) => undefined),
  };
}
function lastListPush(publisher: ReturnType<typeof makePublisher>): { sessions: ListRow[] } {
  const call = publisher.pushSessionList.mock.calls[0];
  return call[0];
}

describe('AcpHistory.flush — RECENT list from the ACP session/list enumeration', () => {
  it('pushes the FULL list, overlaying the CLI summary onto the current untitled row', async () => {
    const publisher = makePublisher();
    const listSessions = vi.fn(async () => [
      { id: 'sess-current', summary: '', timestamp: 200 }, // agent hasn't titled it yet
      { id: 'sess-old', summary: 'Older chat', timestamp: 100 },
    ]);
    const history = new AcpHistory(publisher as never, {
      agent: 'claude',
      acpSessionId: 'sess-current',
      listSessions,
    });
    history.appendUserPrompt('Summarise the diff');
    await history.flush();

    expect(listSessions).toHaveBeenCalledTimes(1);
    const sessions = lastListPush(publisher).sessions;
    expect(sessions.map((s) => s.id)).toEqual(['sess-current', 'sess-old']); // FULL list
    expect(sessions.find((s) => s.id === 'sess-current')?.summary).toBe('Summarise the diff');
    expect(sessions.find((s) => s.id === 'sess-old')?.summary).toBe('Older chat'); // agent title kept
  });

  it('falls back to the current session only when the agent has no session/list (null)', async () => {
    const publisher = makePublisher();
    const history = new AcpHistory(publisher as never, {
      agent: 'claude',
      acpSessionId: 'sess-x',
      listSessions: vi.fn(async () => null),
    });
    history.appendUserPrompt('hi');
    await history.flush();

    const sessions = lastListPush(publisher).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-x');
  });

  it('injects the current session when the enumeration does not list it yet (brand-new turn)', async () => {
    const publisher = makePublisher();
    const history = new AcpHistory(publisher as never, {
      agent: 'claude',
      acpSessionId: 'sess-new',
      listSessions: vi.fn(async () => [{ id: 'sess-old', summary: 'Old', timestamp: 1 }]),
    });
    history.appendUserPrompt('first');
    await history.flush();

    expect(lastListPush(publisher).sessions.map((s) => s.id)).toContain('sess-new');
  });
});

describe('AcpClient.listSessions — ACP session/list, gated on capability', () => {
  function makeClient(): AcpClient {
    const opts: AcpClientOptions = {
      adapter: {} as unknown as AcpClientOptions['adapter'],
      cwd: '/tmp/w',
      onSessionUpdate: () => undefined,
      onRequestPermission: (async () => ({
        outcome: { outcome: 'cancelled' },
      })) as unknown as AcpClientOptions['onRequestPermission'],
    };
    return new AcpClient(opts);
  }
  interface Internals {
    connection: { listSessions: ReturnType<typeof vi.fn> } | null;
    supportsListSessions: boolean;
  }

  it('maps SessionInfo (id/title/updatedAt) to the RECENT shape', async () => {
    const client = makeClient();
    const internals = client as unknown as Internals;
    internals.supportsListSessions = true;
    internals.connection = {
      listSessions: vi.fn(async () => ({
        sessions: [
          { sessionId: 'a', title: 'Chat A', updatedAt: '2026-07-16T12:00:00.000Z' },
          { sessionId: 'b', title: null, updatedAt: null },
        ],
      })),
    };

    const out = await client.listSessions();
    expect(out).toHaveLength(2);
    expect(out![0]).toMatchObject({ id: 'a', summary: 'Chat A' });
    expect(out![0].timestamp).toBe(Date.parse('2026-07-16T12:00:00.000Z'));
    expect(out![1]).toMatchObject({ id: 'b', summary: '' }); // null title → ''
  });

  it('returns null when the agent does not advertise sessionCapabilities.list', async () => {
    const client = makeClient();
    const internals = client as unknown as Internals;
    internals.supportsListSessions = false;
    internals.connection = { listSessions: vi.fn() };
    expect(await client.listSessions()).toBeNull();
    expect(internals.connection.listSessions).not.toHaveBeenCalled();
  });

  it('returns null (best-effort) when session/list throws', async () => {
    const client = makeClient();
    const internals = client as unknown as Internals;
    internals.supportsListSessions = true;
    internals.connection = {
      listSessions: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    expect(await client.listSessions()).toBeNull();
  });
});

describe('pickLatestResumableConversation — auto-resume target selection', () => {
  it('picks the most-recent conversation that is NOT the fresh session', () => {
    expect(
      pickLatestResumableConversation(
        [
          { id: 'fresh', timestamp: 300 },
          { id: 'prior-new', timestamp: 200 },
          { id: 'prior-old', timestamp: 100 },
        ],
        'fresh',
      ),
    ).toBe('prior-new');
  });

  it('returns null when only the fresh session exists (first-ever boot)', () => {
    expect(pickLatestResumableConversation([{ id: 'fresh', timestamp: 1 }], 'fresh')).toBeNull();
  });

  it('returns null for a null / empty enumeration (agent without session/list)', () => {
    expect(pickLatestResumableConversation(null, 'fresh')).toBeNull();
    expect(pickLatestResumableConversation([], 'fresh')).toBeNull();
  });
});

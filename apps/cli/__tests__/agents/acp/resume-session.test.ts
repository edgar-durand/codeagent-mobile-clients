/**
 * JOURNEY guard — resume_session must make the switched conversation
 * REACHABLE (2026-07-16 "conversation never loads on resume"): the
 * loadSession replay is deliberately swallowed (anti-stuck-Thinking
 * guard), so unless the handler (1) re-points the active id, (2) uploads
 * the switched JSONL BEFORE acking, and (3) refreshes the RECENT list,
 * mobile fetches the OLD conversation forever and the chat stays blank.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  dispatchAcpCommand,
  assembleAcpCommandContext,
  type AcpSessionContext,
} from '../../../src/agents/acp/command-handlers';
import type { RemoteCommand } from '@codeam/shared';

function makeCtx(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const client = {
    loadSession: vi.fn(async () => {
      calls.push('loadSession');
    }),
    listSessions: vi.fn(async () => [
      { id: 'new-conv', summary: 'Resumed one', timestamp: 111 },
      { id: 'old-conv', summary: 'Old one', timestamp: 100 },
    ]),
  };
  const relay = {
    sendResult: vi.fn(async (_id: string, status: string) => {
      calls.push(`ack:${status}`);
    }),
  };
  const history = {
    switchActiveSession: vi.fn((id: string) => {
      calls.push(`switch:${id}`);
    }),
  };
  const jsonlHistory = {
    uploadConversationIfChanged: vi.fn(async (id: string) => {
      calls.push(`upload:${id}`);
      return true;
    }),
  };
  const publisher = {
    pushSessionList: vi.fn(async () => {
      calls.push('pushList');
    }),
  };
  const onActiveSessionChanged = vi.fn((id: string) => {
    calls.push(`repoint:${id}`);
  });
  const session = {
    client,
    relay,
    acpSessionId: 'old-conv',
    models: [],
    streaming: {},
    opts: { agent: 'claude', pluginId: 'p1' },
    history,
    jsonlHistory,
    agentCaps: { loadSession: true },
    turnFiles: {},
    getBeads: () => null,
    publisher,
    recentStderr: [],
    budgetRecovery: {},
    budgetReachedFlag: { get: () => false, set: () => undefined },
    onActiveSessionChanged,
    ...over,
  } as unknown as AcpSessionContext;
  return { session, calls, client, relay, history, jsonlHistory, publisher, onActiveSessionChanged };
}

function resumeCmd(id = 'new-conv'): RemoteCommand {
  return { id: 'cmd-1', sessionId: 's1', type: 'resume_session', payload: { id } } as RemoteCommand;
}

describe('resume_session — switched conversation becomes reachable', () => {
  it('re-points the active id, uploads the JSONL BEFORE acking, and refreshes RECENT', async () => {
    const { session, calls, history, jsonlHistory, onActiveSessionChanged, publisher, relay } =
      makeCtx();
    await dispatchAcpCommand(assembleAcpCommandContext(session, resumeCmd()));
    // Let the fire-and-forget list push settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(history.switchActiveSession).toHaveBeenCalledWith('new-conv');
    expect(onActiveSessionChanged).toHaveBeenCalledWith('new-conv');
    expect(jsonlHistory.uploadConversationIfChanged).toHaveBeenCalledWith('new-conv');
    expect(publisher.pushSessionList).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'claude' }),
    );
    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', {
      sessionId: 'new-conv',
    });
    // ORDER: the upload lands BEFORE the completed ack, so the mobile's
    // follow-up GET finds the conversation already stored.
    expect(calls.indexOf('upload:new-conv')).toBeGreaterThan(-1);
    expect(calls.indexOf('upload:new-conv')).toBeLessThan(calls.indexOf('ack:completed'));
  });

  it('a failed loadSession acks failed and never re-points or uploads', async () => {
    const { session, history, jsonlHistory, onActiveSessionChanged, relay } = makeCtx();
    (session.client.loadSession as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Session not found'),
    );
    await dispatchAcpCommand(assembleAcpCommandContext(session, resumeCmd()));

    expect(relay.sendResult).toHaveBeenCalledWith(
      'cmd-1',
      'failed',
      expect.objectContaining({ error: expect.stringContaining('Session not found') }),
    );
    expect(history.switchActiveSession).not.toHaveBeenCalled();
    expect(onActiveSessionChanged).not.toHaveBeenCalled();
    expect(jsonlHistory.uploadConversationIfChanged).not.toHaveBeenCalled();
  });

  it('a transcript-upload failure is non-fatal — the resume still completes', async () => {
    const { session, relay, jsonlHistory } = makeCtx();
    (jsonlHistory.uploadConversationIfChanged as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('backend down'),
    );
    await dispatchAcpCommand(assembleAcpCommandContext(session, resumeCmd()));

    expect(relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', {
      sessionId: 'new-conv',
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchSquadRoster,
  postAgentSwitchEvent,
  _transport,
} from '../../src/services/pairing.service';

describe('fetchSquadRoster', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('posts {sessionId, pluginId} to /api/plugin/agents/roster with the plugin token', async () => {
    const spy = vi.spyOn(_transport, 'postJsonAuthed').mockResolvedValue({
      data: { agents: [{ agentId: 'claude', displayName: 'Claude' }], handoffsEnabled: true },
    });
    await fetchSquadRoster({ sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' });
    const [url, body, token] = spy.mock.calls[0];
    expect(url).toMatch(/\/api\/plugin\/agents\/roster$/);
    expect(body).toEqual({ sessionId: 's1', pluginId: 'p1' });
    expect(token).toBe('tok');
  });

  it('returns data on success', async () => {
    vi.spyOn(_transport, 'postJsonAuthed').mockResolvedValue({
      data: {
        agents: [
          { agentId: 'claude', displayName: 'Claude' },
          { agentId: 'codex', displayName: 'Codex' },
        ],
        handoffsEnabled: true,
      },
    });
    const res = await fetchSquadRoster({ sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' });
    expect(res).toEqual({
      agents: [
        { agentId: 'claude', displayName: 'Claude' },
        { agentId: 'codex', displayName: 'Codex' },
      ],
      handoffsEnabled: true,
    });
  });

  it('returns null on non-2xx (thrown transport error)', async () => {
    vi.spyOn(_transport, 'postJsonAuthed').mockRejectedValue(
      Object.assign(new Error('HTTP 404'), { statusCode: 404 }),
    );
    const res = await fetchSquadRoster({ sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' });
    expect(res).toBeNull();
  });

  it('returns null when the response is malformed (missing agents array)', async () => {
    vi.spyOn(_transport, 'postJsonAuthed').mockResolvedValue({
      data: { handoffsEnabled: true },
    });
    const res = await fetchSquadRoster({ sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' });
    expect(res).toBeNull();
  });

  it('returns null when data is missing entirely', async () => {
    vi.spyOn(_transport, 'postJsonAuthed').mockResolvedValue(null);
    const res = await fetchSquadRoster({ sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' });
    expect(res).toBeNull();
  });

  it('coerces handoffsEnabled to boolean strict-true', async () => {
    vi.spyOn(_transport, 'postJsonAuthed').mockResolvedValue({
      data: { agents: [{ agentId: 'claude', displayName: 'Claude' }], handoffsEnabled: 'yes' },
    });
    const res = await fetchSquadRoster({ sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' });
    expect(res).toEqual({
      agents: [{ agentId: 'claude', displayName: 'Claude' }],
      handoffsEnabled: false,
    });
  });
});

describe('postAgentSwitchEvent — handoff event types', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('accepts handoff_proposed as a valid type', async () => {
    const spy = vi.spyOn(_transport, 'postJsonAuthed').mockResolvedValue({});
    const res = await postAgentSwitchEvent({
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 'tok',
      type: 'handoff_proposed',
      payload: { proposalId: 'prop-1' },
    });
    expect(res).toEqual({ ok: true });
    const [url, body] = spy.mock.calls[0];
    expect(url).toMatch(/\/api\/agent-switch\/events$/);
    expect(body).toMatchObject({ type: 'handoff_proposed', payload: { proposalId: 'prop-1' } });
  });

  it('accepts handoff_resolved as a valid type', async () => {
    const spy = vi.spyOn(_transport, 'postJsonAuthed').mockResolvedValue({});
    const res = await postAgentSwitchEvent({
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 'tok',
      type: 'handoff_resolved',
      payload: { proposalId: 'prop-1', accepted: true },
    });
    expect(res).toEqual({ ok: true });
    const [, body] = spy.mock.calls[0];
    expect(body).toMatchObject({ type: 'handoff_resolved' });
  });
});

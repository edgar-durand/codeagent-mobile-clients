import { describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../../../src/agents/acp/client';
import type { AcpClientOptions } from '../../../src/agents/acp/client';

/**
 * Regression for the "resume from history hangs the agent" bug.
 *
 * Resuming the conversation that is ALREADY the active session (the user taps
 * the current conversation in the history list — the common case) used to issue
 * `session/load` for the live session. Claude Code resumes by RELAUNCHING with
 * `--resume`, so the adapter tried to relaunch Claude into the session it was
 * already serving; the process wedged and every subsequent prompt hung 90s with
 * "adapter sent no updates" — the agent looked dead. The guard skips the
 * redundant RPC so the live session keeps responding.
 */

function makeClient(overrides?: Partial<AcpClientOptions>): AcpClient {
  const opts: AcpClientOptions = {
    adapter: {} as unknown as AcpClientOptions['adapter'],
    cwd: '/tmp/work',
    onSessionUpdate: () => undefined,
    onRequestPermission: (async () => ({
      outcome: { outcome: 'cancelled' },
    })) as unknown as AcpClientOptions['onRequestPermission'],
    ...overrides,
  };
  return new AcpClient(opts);
}

interface ClientInternals {
  connection: { loadSession: ReturnType<typeof vi.fn> } | null;
  sessionId: string | null;
}

describe('AcpClient.loadSession — self-load guard', () => {
  it('skips session/load when the target is already the active session (no agent wedge)', async () => {
    const client = makeClient();
    const loadSession = vi.fn().mockResolvedValue(undefined);
    const internals = client as unknown as ClientInternals;
    internals.connection = { loadSession };
    internals.sessionId = 'sess-active';

    await client.loadSession('sess-active');

    expect(loadSession).not.toHaveBeenCalled(); // redundant, harmful RPC skipped
    expect(internals.sessionId).toBe('sess-active'); // still the live session
  });

  it('issues session/load for a different (older) conversation', async () => {
    const client = makeClient();
    const loadSession = vi.fn().mockResolvedValue(undefined);
    const internals = client as unknown as ClientInternals;
    internals.connection = { loadSession };
    internals.sessionId = 'sess-active';

    await client.loadSession('sess-older');

    expect(loadSession).toHaveBeenCalledWith({
      sessionId: 'sess-older',
      cwd: '/tmp/work',
      mcpServers: [],
    });
    expect(internals.sessionId).toBe('sess-older');
  });

  it('forwards opts.mcpServers into the session/load request', async () => {
    const mcpServers = [
      { name: 'jira', command: '/usr/bin/node', args: ['cli.js', 'mcp-run', 'jira'], env: [] },
    ];
    const client = makeClient({ mcpServers });
    const loadSession = vi.fn().mockResolvedValue(undefined);
    const internals = client as unknown as ClientInternals;
    internals.connection = { loadSession };
    internals.sessionId = 'sess-active';

    await client.loadSession('sess-older');

    expect(loadSession).toHaveBeenCalledWith({
      sessionId: 'sess-older',
      cwd: '/tmp/work',
      mcpServers,
    });
  });
});

/**
 * The load-replay guard (2026-07-16). `session/load` replays the whole prior
 * conversation as `session/update` notifications; without bracketing the RPC in
 * beginLoadReplay/endLoadReplay those land as OPEN streaming chunks that never
 * close → mobile stuck on "Thinking…"/STOP after `resume_session`. The baton
 * driver + reestablishSession already do this; the public loadSession() must too.
 */
describe('AcpClient.loadSession — load-replay guard', () => {
  it('brackets session/load with beginLoadReplay → load → endLoadReplay', async () => {
    const calls: string[] = [];
    const beginLoadReplay = vi.fn(() => void calls.push('begin'));
    const endLoadReplay = vi.fn(() => void calls.push('end'));
    const client = makeClient({ beginLoadReplay, endLoadReplay });
    const loadSession = vi.fn().mockImplementation(async () => void calls.push('load'));
    const internals = client as unknown as ClientInternals;
    internals.connection = { loadSession };
    internals.sessionId = 'sess-active';

    await client.loadSession('sess-older');

    expect(calls).toEqual(['begin', 'load', 'end']); // replay swallowed around the RPC
  });

  it('runs endLoadReplay even when session/load throws (finally-safe)', async () => {
    const beginLoadReplay = vi.fn();
    const endLoadReplay = vi.fn();
    const client = makeClient({ beginLoadReplay, endLoadReplay });
    const loadSession = vi.fn().mockRejectedValue(new Error('boom'));
    const internals = client as unknown as ClientInternals;
    internals.connection = { loadSession };
    internals.sessionId = 'sess-active';

    await expect(client.loadSession('sess-older')).rejects.toThrow('boom');
    expect(beginLoadReplay).toHaveBeenCalledTimes(1);
    expect(endLoadReplay).toHaveBeenCalledTimes(1); // never leaks the swallow state
  });

  it('does NOT arm the replay guard on a self-load (no RPC, nothing to swallow)', async () => {
    const beginLoadReplay = vi.fn();
    const endLoadReplay = vi.fn();
    const client = makeClient({ beginLoadReplay, endLoadReplay });
    const internals = client as unknown as ClientInternals;
    internals.connection = { loadSession: vi.fn() };
    internals.sessionId = 'sess-active';

    await client.loadSession('sess-active');

    expect(beginLoadReplay).not.toHaveBeenCalled();
    expect(endLoadReplay).not.toHaveBeenCalled();
  });
});

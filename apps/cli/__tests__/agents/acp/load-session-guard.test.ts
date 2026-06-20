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

function makeClient(): AcpClient {
  const opts: AcpClientOptions = {
    adapter: {} as unknown as AcpClientOptions['adapter'],
    cwd: '/tmp/work',
    onSessionUpdate: () => undefined,
    onRequestPermission: (async () => ({
      outcome: { outcome: 'cancelled' },
    })) as unknown as AcpClientOptions['onRequestPermission'],
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
});

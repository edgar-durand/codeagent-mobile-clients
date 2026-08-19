import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
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

  // Harness invariant (prevention, not just regression): a session/load that
  // isn't bracketed by the replay guard publishes the whole replayed conversation
  // as a live streaming turn → the resume-hang. This static check fails the build
  // the moment someone adds a raw `connection.loadSession(` without a preceding
  // beginLoadReplay — so the class of bug can't come back through a new call site.
  it('INVARIANT: every raw connection.loadSession call is guarded by beginLoadReplay', () => {
    const src = readFileSync(join(__dirname, '../../../src/agents/acp/client.ts'), 'utf8');
    const lines = src.split('\n');
    const rawCallLines = lines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => /\.connection\.loadSession\s*\(/.test(line));

    expect(rawCallLines.length).toBeGreaterThan(0); // guard against the regex silently matching nothing
    for (const { idx } of rawCallLines) {
      const preceding = lines.slice(Math.max(0, idx - 10), idx).join('\n');
      expect(
        /beginLoadReplay/.test(preceding),
        `raw connection.loadSession at client.ts:${idx + 1} is missing a beginLoadReplay guard`,
      ).toBe(true);
    }
  });
});

/**
 * Regression for the 2026-08-18 baton "Switching…" incident: `session/load`
 * was the ONE handshake RPC with no timeout. `claude-agent-acp` answered
 * neither ok nor error for a session id with no transcript on disk, so the
 * caller (the baton's AcpDriver) waited forever and the hand-off wedged.
 */
describe('AcpClient.loadSession — bounded', () => {
  it('rejects with ACP_LOAD_SESSION_TIMEOUT when the adapter never answers', async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient({
        adapter: { requiresAgentBinary: 'claude' } as unknown as AcpClientOptions['adapter'],
      });
      const internals = client as unknown as ClientInternals;
      // Never settles — exactly what the live adapter did.
      internals.connection = { loadSession: vi.fn(() => new Promise<never>(() => {})) };
      internals.sessionId = 'sess-active';

      const p = client.loadSession('sess-never-written');
      const assertion = expect(p).rejects.toThrow(/ACP_LOAD_SESSION_TIMEOUT/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

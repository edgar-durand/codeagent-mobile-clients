import { describe, it, expect, vi } from 'vitest';
import { AcpClient } from '../../../src/agents/acp/client';
import type { AcpClientOptions } from '../../../src/agents/acp/client';

/**
 * `AcpClient.newConversation()` — a fresh `session/new` used by Agent Packs to
 * isolate each stage's context. A fresh session does NOT inherit the initial
 * managed session's `INITIAL_AGENT_MODE=agent-full-access` env, so on an
 * auto-approve (codespace / self-hosted) session it comes up in the agent's
 * default ask-per-tool mode → the stage agent's writes abort at the permission
 * layer (Agent Packs 2026-08-08 incident). `ensureFullAutoMode` re-asserts the
 * agent's full-bypass mode on the fresh session.
 */
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
  connection: {
    newSession: ReturnType<typeof vi.fn>;
    setSessionMode: ReturnType<typeof vi.fn>;
  } | null;
  sessionId: string | null;
  currentModeId: string | undefined;
}

const MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'bypassPermissions', name: 'Bypass Permissions' },
  ],
};

describe('AcpClient.newConversation — full-auto mode re-assertion', () => {
  it('re-asserts the agent full-bypass mode on a managed session', async () => {
    const client = makeClient();
    const internals = client as unknown as Internals;
    const setSessionMode = vi.fn(async () => undefined);
    internals.connection = {
      newSession: vi.fn(async () => ({ sessionId: 'sess-fresh', modes: MODES, configOptions: [] })),
      setSessionMode,
    };

    const id = await client.newConversation({ ensureFullAutoMode: true });

    expect(id).toBe('sess-fresh');
    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: 'sess-fresh',
      modeId: 'bypassPermissions',
    });
    expect(internals.currentModeId).toBe('bypassPermissions');
  });

  it('leaves the fresh session in its default ask-mode when not managed', async () => {
    const client = makeClient();
    const internals = client as unknown as Internals;
    const setSessionMode = vi.fn(async () => undefined);
    internals.connection = {
      newSession: vi.fn(async () => ({ sessionId: 'sess-local', modes: MODES, configOptions: [] })),
      setSessionMode,
    };

    await client.newConversation({ ensureFullAutoMode: false });
    expect(setSessionMode).not.toHaveBeenCalled();
    expect(internals.currentModeId).toBe('default');
  });

  it('is a no-op (never throws) when the agent advertises no bypass mode', async () => {
    const client = makeClient();
    const internals = client as unknown as Internals;
    const setSessionMode = vi.fn(async () => undefined);
    internals.connection = {
      newSession: vi.fn(async () => ({
        sessionId: 'sess-nomodes',
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
        configOptions: [],
      })),
      setSessionMode,
    };

    const id = await client.newConversation({ ensureFullAutoMode: true });
    expect(id).toBe('sess-nomodes');
    expect(setSessionMode).not.toHaveBeenCalled();
  });

  it('swallows a setSessionMode failure — the conversation still starts', async () => {
    const client = makeClient();
    const internals = client as unknown as Internals;
    internals.connection = {
      newSession: vi.fn(async () => ({ sessionId: 'sess-x', modes: MODES, configOptions: [] })),
      setSessionMode: vi.fn(async () => {
        throw new Error('set_mode not supported');
      }),
    };

    await expect(client.newConversation({ ensureFullAutoMode: true })).resolves.toBe('sess-x');
  });
});

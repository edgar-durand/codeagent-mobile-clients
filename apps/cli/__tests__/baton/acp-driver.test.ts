import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AcpDriver, type AcpDriverDeps } from '../../src/baton/acp-driver';
import type { AcpClient } from '../../src/agents/acp/client';
import type { AcpPublisher } from '../../src/agents/acp/publisher';
import type { StreamingState, AcpRunnerOptions } from '../../src/agents/acp/runner';
import type { RuntimeStrategy } from '../../src/agents/strategy';
import type { CommandRelayService, RemoteCommand } from '../../src/services/command-relay.service';

// A minimal ACP client fake — start() returns the handshake shape the driver
// reads (sessionId + initialize.agentCapabilities). Cast to AcpClient (vitest
// mock) since the driver only ever touches start/loadSession/stop here.
function fakeClient(id: string) {
  return {
    start: vi.fn(async () => ({
      sessionId: id,
      initialize: { agentCapabilities: { loadSession: true } },
    })),
    loadSession: vi.fn(async (_id: string) => {}),
    stop: vi.fn(async () => {}),
    getCurrentModelId: vi.fn((): string | undefined => undefined),
  };
}

let tempDir: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-acp-'));
});
afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeDeps(client: ReturnType<typeof fakeClient>): {
  deps: AcpDriverDeps;
  relay: { sendResult: ReturnType<typeof vi.fn> };
} {
  const relay = { sendResult: vi.fn(async () => {}) };
  const deps: AcpDriverDeps = {
    client: client as unknown as AcpClient,
    publisher: {
      publishOutput: vi.fn(async () => {}),
      publishAwaitingAnswer: vi.fn(async () => {}),
    } as unknown as AcpPublisher,
    streaming: {
      beginLoadReplay: vi.fn(),
      endLoadReplay: vi.fn(),
    } as unknown as StreamingState,
    runtime: { listModels: vi.fn(async () => [{ id: 'm1' }]) } as unknown as RuntimeStrategy,
    recentStderr: [],
    opts: {
      agent: 'claude',
      sessionId: 's',
      pluginId: 'p',
      pluginAuthToken: 't',
      adapter: {},
      cwd: tempDir,
    } as unknown as AcpRunnerOptions,
    getRelay: () => relay as unknown as CommandRelayService,
  };
  return { deps, relay };
}

describe('AcpDriver', () => {
  it('start(id) spawns then loadSession(id) — resumes the shared conversation', async () => {
    const client = fakeClient('acp-fresh');
    const d = new AcpDriver(makeDeps(client).deps);
    const id = await d.start('conv-42');
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.loadSession).toHaveBeenCalledWith('conv-42');
    expect(id).toBe('conv-42');
    expect(d.kind).toBe('mobile_acp');
  });

  it('brackets loadSession with the streaming load-replay guard (no stuck "Thinking…")', async () => {
    const client = fakeClient('acp-fresh');
    const { deps } = makeDeps(client);
    const streaming = deps.streaming as unknown as {
      beginLoadReplay: ReturnType<typeof vi.fn>;
      endLoadReplay: ReturnType<typeof vi.fn>;
    };
    // loadSession resolving proves ordering: begin before, end after.
    client.loadSession.mockImplementationOnce(async () => {
      expect(streaming.beginLoadReplay).toHaveBeenCalledTimes(1);
      expect(streaming.endLoadReplay).not.toHaveBeenCalled();
    });
    await new AcpDriver(deps).start('conv-42');
    expect(streaming.beginLoadReplay).toHaveBeenCalledTimes(1);
    expect(streaming.endLoadReplay).toHaveBeenCalledTimes(1);
  });

  it('ends the load-replay guard even when loadSession throws (finally)', async () => {
    const client = fakeClient('acp-fresh');
    const { deps } = makeDeps(client);
    const streaming = deps.streaming as unknown as { endLoadReplay: ReturnType<typeof vi.fn> };
    client.loadSession.mockRejectedValueOnce(new Error('resume failed'));
    await expect(new AcpDriver(deps).start('conv-42')).rejects.toThrow('resume failed');
    expect(streaming.endLoadReplay).toHaveBeenCalledTimes(1);
  });

  it('start(undefined) spawns fresh and returns the new session id (no load)', async () => {
    const client = fakeClient('acp-fresh');
    const d = new AcpDriver(makeDeps(client).deps);
    const id = await d.start();
    expect(client.loadSession).not.toHaveBeenCalled();
    expect(id).toBe('acp-fresh');
  });

  it('whenSafeToYield waits for the in-flight turn to end', async () => {
    const client = fakeClient('x');
    const d = new AcpDriver(makeDeps(client).deps);
    await d.start('conv-1');
    d.beginTurn();
    let done = false;
    const p = d.whenSafeToYield().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    d.endTurn();
    await p;
    expect(done).toBe(true);
  });

  it('stop stops the client', async () => {
    const client = fakeClient('x');
    const d = new AcpDriver(makeDeps(client).deps);
    await d.start('conv-1');
    await d.stop();
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it('dispatch routes a non-baton command through dispatchAcpCommand (list_models acks with models + currentModelId)', async () => {
    const client = fakeClient('x');
    // The adapter's in-use model must ride the list_models result so mobile can
    // mark it (the model line under the composer).
    client.getCurrentModelId.mockReturnValue('m1');
    const { deps, relay } = makeDeps(client);
    const d = new AcpDriver(deps);
    await d.start('conv-1');
    await d.dispatch({
      id: 'cmd1',
      sessionId: 's',
      type: 'list_models',
      payload: {},
    } as RemoteCommand);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd1', 'completed', {
      models: [{ id: 'm1' }],
      currentModelId: 'm1',
    });
  });

  it('dispatch brackets the turn so whenSafeToYield blocks until it resolves', async () => {
    const client = fakeClient('x');
    const { deps, relay } = makeDeps(client);
    // Make the underlying ack hang so the dispatched turn is still "active".
    let releaseAck: () => void = () => {};
    relay.sendResult.mockImplementation(() => new Promise<void>((r) => (releaseAck = () => r())));
    const d = new AcpDriver(deps);
    await d.start('conv-1');
    const dispatched = d.dispatch({
      id: 'cmd1',
      sessionId: 's',
      type: 'list_models',
      payload: {},
    } as RemoteCommand);
    // Flush microtasks (async ensureSession + beginTurn) so the turn is active
    // and the dispatch is now parked on the hanging ack before we probe yield.
    await new Promise((r) => setTimeout(r, 0));
    let yielded = false;
    const y = d.whenSafeToYield().then(() => (yielded = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(yielded).toBe(false); // turn still active — hand-off must wait
    releaseAck();
    await dispatched;
    await y;
    expect(yielded).toBe(true);
  });

  it('dispatch before start acks failed with BATON_MOBILE_NOT_STARTED', async () => {
    const client = fakeClient('x');
    const { deps, relay } = makeDeps(client);
    const d = new AcpDriver(deps);
    await d.dispatch({
      id: 'cmd2',
      sessionId: 's',
      type: 'list_models',
      payload: {},
    } as RemoteCommand);
    expect(relay.sendResult).toHaveBeenCalledWith('cmd2', 'failed', {
      code: 'BATON_MOBILE_NOT_STARTED',
    });
  });

  it('start() stops the client when loadSession throws — driver stays retryable, not half-started', async () => {
    const client = fakeClient('acp-fresh');
    client.loadSession.mockRejectedValueOnce(new Error('resume failed'));
    const d = new AcpDriver(makeDeps(client).deps);

    await expect(d.start('conv-42')).rejects.toThrow('resume failed');

    // client.start() DID succeed before loadSession threw — the driver must
    // stop it so a retried take-control doesn't hard-throw on a still-alive
    // adapter, and must not have adopted the failed conversation id.
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it('start() propagates a client.start() failure and still (harmlessly) calls stop()', async () => {
    const client = fakeClient('acp-fresh');
    client.start.mockRejectedValueOnce(new Error('handshake failed'));
    const d = new AcpDriver(makeDeps(client).deps);

    await expect(d.start('conv-42')).rejects.toThrow('handshake failed');

    // The real AcpClient.stop() no-ops when there's no child (it already
    // cleaned itself up on the handshake failure) — calling it unconditionally
    // here is cheap defense-in-depth, not a behavior the driver relies on.
    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(client.loadSession).not.toHaveBeenCalled();
  });

  it('a failed start() leaves the driver unstarted for dispatch (BATON_MOBILE_NOT_STARTED)', async () => {
    const client = fakeClient('acp-fresh');
    client.loadSession.mockRejectedValueOnce(new Error('resume failed'));
    const { deps, relay } = makeDeps(client);
    const d = new AcpDriver(deps);

    await expect(d.start('conv-42')).rejects.toThrow('resume failed');
    await d.dispatch({
      id: 'cmd3',
      sessionId: 's',
      type: 'list_models',
      payload: {},
    } as RemoteCommand);

    expect(relay.sendResult).toHaveBeenCalledWith('cmd3', 'failed', {
      code: 'BATON_MOBILE_NOT_STARTED',
    });
  });

  it('stop() nulls acpSessionId/session so a stray dispatch fails clean, not on stale state', async () => {
    const client = fakeClient('x');
    const { deps, relay } = makeDeps(client);
    const d = new AcpDriver(deps);
    await d.start('conv-1');
    await d.dispatch({
      id: 'cmd-warm',
      sessionId: 's',
      type: 'list_models',
      payload: {},
    } as RemoteCommand);
    relay.sendResult.mockClear();

    await d.stop();
    await d.dispatch({
      id: 'cmd4',
      sessionId: 's',
      type: 'list_models',
      payload: {},
    } as RemoteCommand);

    expect(relay.sendResult).toHaveBeenCalledWith('cmd4', 'failed', {
      code: 'BATON_MOBILE_NOT_STARTED',
    });
  });
});

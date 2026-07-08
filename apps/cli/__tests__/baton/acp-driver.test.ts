import { describe, it, expect, vi } from 'vitest';
import { AcpDriver } from '../../src/baton/acp-driver';

function fakeClient(id: string) {
  return {
    start: vi.fn(async () => ({ sessionId: id })),
    loadSession: vi.fn(async (_id: string) => {}),
    stop: vi.fn(async () => {}),
  };
}

describe('AcpDriver', () => {
  it('start(id) spawns then loadSession(id) — resumes the shared conversation', async () => {
    const client = fakeClient('acp-fresh');
    const d = new AcpDriver({ client });
    const id = await d.start('conv-42');
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.loadSession).toHaveBeenCalledWith('conv-42');
    expect(id).toBe('conv-42');
    expect(d.kind).toBe('mobile_acp');
  });

  it('start(undefined) spawns fresh and returns the new session id (no load)', async () => {
    const client = fakeClient('acp-fresh');
    const d = new AcpDriver({ client });
    const id = await d.start();
    expect(client.loadSession).not.toHaveBeenCalled();
    expect(id).toBe('acp-fresh');
  });

  it('whenSafeToYield waits for the in-flight turn to end', async () => {
    const client = fakeClient('x');
    const d = new AcpDriver({ client });
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
    const d = new AcpDriver({ client });
    await d.start('conv-1');
    await d.stop();
    expect(client.stop).toHaveBeenCalledTimes(1);
  });
});

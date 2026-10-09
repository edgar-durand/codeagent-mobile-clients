import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { RestartableStdioProxy, type ProxyChildSpec } from '../../src/integrations/stdio-proxy';

/** codeagent-sjk (c) + (e): the two token-swap edges the review flagged. */

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    kill: (sig?: string) => void;
    killed: boolean;
    exitCode: number | null;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  child.killed = false;
  child.exitCode = null;
  return child;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SPEC: ProxyChildSpec = { command: 'x', args: [], env: {} };
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

/** A proxy whose first spawn is immediate and whose SWAP spawnSpec we control. */
async function makeProxy() {
  const children: ReturnType<typeof fakeChild>[] = [];
  let swapSpec: ((s: ProxyChildSpec) => void) | null = null;
  let restart = false;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proxy = new RestartableStdioProxy({
    spawnSpec: () =>
      children.length === 0
        ? Promise.resolve(SPEC)
        : new Promise<ProxyChildSpec>((resolve) => {
            swapSpec = resolve;
          }),
    shouldRestartNow: () => restart,
    stdin,
    stdout,
    spawnImpl: (() => {
      const c = fakeChild();
      children.push(c);
      return c;
    }) as never,
  });
  const done = proxy.start();
  await wait(20);
  // Handshake so the proxy has an initialize to replay.
  stdin.write(JSON.stringify(INIT) + '\n');
  await wait(10);
  return {
    children,
    stdin,
    done,
    /** Answer `initialize` with a token swap due → the proxy starts a swap. */
    triggerSwap: async () => {
      restart = true;
      children[0].stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
      await wait(20);
    },
    resolveSwap: () => swapSpec?.(SPEC),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('RestartableStdioProxy — swap edges', () => {
  it('(e) the agent hanging up during the token fetch never spawns an orphan child', async () => {
    const p = await makeProxy();
    await p.triggerSwap();
    // Token fetch in flight; the agent closes our stdin meanwhile.
    p.stdin.end();
    await wait(20);
    p.resolveSwap();
    await wait(20);
    expect(p.children).toHaveLength(1);
  });

  it('(c) a restarted server rejecting the replayed initialize is logged, not silent', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const p = await makeProxy();
    await p.triggerSwap();
    p.resolveSwap();
    await wait(20);
    expect(p.children).toHaveLength(2);
    p.children[1].stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: '__codeam_replay_init__',
        error: { code: -32600, message: 'invalid token' },
      }) + '\n',
    );
    await wait(20);
    const logged = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('rejected the replayed initialize');
    expect(logged).toContain('invalid token');
  });
});

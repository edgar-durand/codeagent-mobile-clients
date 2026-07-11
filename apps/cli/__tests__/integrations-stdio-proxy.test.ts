import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { RestartableStdioProxy, type ProxyChildSpec } from '../src/integrations/stdio-proxy';

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-mcp-server.cjs');

interface RpcLine {
  id?: number;
  result?: { token?: string; tools?: Array<{ token?: string }> };
}

function makeStreams(): { stdin: PassThrough; stdout: PassThrough; outLines: string[] } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const outLines: string[] = [];
  let buf = '';
  stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let idx: number;
    // eslint-disable-next-line no-cond-assign
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length > 0) outLines.push(line);
    }
  });
  return { stdin, stdout, outLines };
}

function send(stdin: PassThrough, obj: unknown): void {
  stdin.write(JSON.stringify(obj) + '\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsedLines(outLines: string[]): RpcLine[] {
  const out: RpcLine[] = [];
  for (const l of outLines) {
    try {
      out.push(JSON.parse(l) as RpcLine);
    } catch {
      // ignore
    }
  }
  return out;
}

async function waitForId(outLines: string[], id: number, timeoutMs = 3000): Promise<RpcLine> {
  const start = Date.now();
  for (;;) {
    const found = parsedLines(outLines).find((l) => l.id === id);
    if (found) return found;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForId(${id}): timed out; saw ${JSON.stringify(outLines)}`);
    }
    await sleep(15);
  }
}

function countId(outLines: string[], id: number): number {
  return parsedLines(outLines).filter((l) => l.id === id).length;
}

/** Probe-retry: keep sending fresh `tools/list` requests until one responds
 * with `expectedToken`, proving the child behind the proxy has been swapped. */
async function waitForToken(
  stdin: PassThrough,
  outLines: string[],
  expectedToken: string,
  timeoutMs = 4000,
): Promise<void> {
  const start = Date.now();
  let probeId = 9000;
  for (;;) {
    const id = probeId++;
    send(stdin, { jsonrpc: '2.0', id, method: 'tools/list', params: {} });
    try {
      const resp = await waitForId(outLines, id, 400);
      if (resp.result?.tools?.[0]?.token === expectedToken) return;
    } catch {
      // no reply within the short window (child mid-swap) — retry
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForToken(${expectedToken}): timed out`);
    }
    await sleep(50);
  }
}

function spawnSpecFactory(
  tokens: string[],
  extraEnvPerSpawn: Array<Record<string, string>> = [],
): {
  spawnSpec: () => Promise<ProxyChildSpec>;
} {
  let i = 0;
  const spawnSpec = async (): Promise<ProxyChildSpec> => {
    const token = tokens[Math.min(i, tokens.length - 1)];
    const extra = extraEnvPerSpawn[i] ?? {};
    i += 1;
    return {
      command: process.execPath,
      args: [FIXTURE],
      env: { FAKE_TOKEN: token, INSTANCE_TAG: `instance-${i}`, ...extra },
    };
  };
  return { spawnSpec };
}

describe('RestartableStdioProxy', () => {
  it('forwards client lines to the child and child lines back to the client verbatim', async () => {
    const { stdin, stdout, outLines } = makeStreams();
    const { spawnSpec } = spawnSpecFactory(['tok-a']);
    const proxy = new RestartableStdioProxy({ spawnSpec, shouldRestartNow: () => false, stdin, stdout });
    const done = proxy.start();

    send(stdin, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const initResp = await waitForId(outLines, 1);
    expect(initResp.result?.token).toBe('tok-a');

    send(stdin, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listResp = await waitForId(outLines, 2);
    expect(listResp.result?.tools?.[0]?.token).toBe('tok-a');

    stdin.end();
    await done;
  });

  it('restarts the child once shouldRestartNow is true and in-flight is empty, replaying initialize without duplicating its response', async () => {
    const { stdin, stdout, outLines } = makeStreams();
    const { spawnSpec } = spawnSpecFactory(['tok-old', 'tok-new']);
    let restart = false;
    const proxy = new RestartableStdioProxy({
      spawnSpec,
      shouldRestartNow: () => restart,
      stdin,
      stdout,
    });
    const done = proxy.start();

    send(stdin, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitForId(outLines, 1);

    send(stdin, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const before = await waitForId(outLines, 2);
    expect(before.result?.tools?.[0]?.token).toBe('tok-old');

    // Flip the flag: the NEXT completed response should trigger the
    // opportunistic restart check.
    restart = true;
    send(stdin, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const trigger = await waitForId(outLines, 3);
    // The response to id 3 is still served by the OLD child — the swap
    // happens strictly AFTER this response is forwarded.
    expect(trigger.result?.tools?.[0]?.token).toBe('tok-old');

    await waitForToken(stdin, outLines, 'tok-new');

    expect(countId(outLines, 1)).toBe(1); // no duplicate initialize response reached the client

    stdin.end();
    await done;
  });

  it('defers a restart while a request is in flight, then restarts once it completes', async () => {
    const { stdin, stdout, outLines } = makeStreams();
    const { spawnSpec } = spawnSpecFactory(['tok-old', 'tok-new']);
    let restart = false;
    const proxy = new RestartableStdioProxy({
      spawnSpec,
      shouldRestartNow: () => restart,
      stdin,
      stdout,
    });
    const done = proxy.start();

    send(stdin, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitForId(outLines, 1);

    restart = true;
    // id 2 stays in-flight — the fixture deliberately never replies to `hold`.
    send(stdin, { jsonrpc: '2.0', id: 2, method: 'hold', params: {} });

    send(stdin, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const resp3 = await waitForId(outLines, 3);
    // id 2 is still in-flight, so no swap should have happened yet.
    expect(resp3.result?.tools?.[0]?.token).toBe('tok-old');

    // Settle window: confirm the restart really is deferred, not just slow.
    await sleep(200);
    send(stdin, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    const resp5 = await waitForId(outLines, 5);
    expect(resp5.result?.tools?.[0]?.token).toBe('tok-old');

    // Release the held request — inflight drops to 0, restart proceeds.
    send(stdin, { jsonrpc: '2.0', method: 'release' });
    await waitForId(outLines, 2);

    await waitForToken(stdin, outLines, 'tok-new');
    expect(countId(outLines, 1)).toBe(1);

    stdin.end();
    await done;
  });

  it('ends the proxy with the child exit code on an unexpected child death', async () => {
    const { stdin, stdout } = makeStreams();
    const originalExitCode = process.exitCode;
    const spawnSpec = async (): Promise<ProxyChildSpec> => ({
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      env: {},
    });
    const proxy = new RestartableStdioProxy({ spawnSpec, shouldRestartNow: () => false, stdin, stdout });

    await proxy.start();

    expect(process.exitCode).toBe(7);
    process.exitCode = originalExitCode;
  });

  it('never forwards straggler output from a slow-dying old child after a swap', async () => {
    const { stdin, stdout, outLines } = makeStreams();
    // First child ignores SIGTERM for 300 ms, then emits ONE straggler line
    // and exits — that line must never reach the client.
    const { spawnSpec } = spawnSpecFactory(
      ['tok-old', 'tok-new'],
      [{ IGNORE_SIGTERM_MS: '300' }],
    );
    let restart = false;
    const proxy = new RestartableStdioProxy({
      spawnSpec,
      shouldRestartNow: () => restart,
      stdin,
      stdout,
    });
    const done = proxy.start();

    send(stdin, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitForId(outLines, 1);

    restart = true;
    send(stdin, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await waitForId(outLines, 2); // completed response → triggers the swap

    await waitForToken(stdin, outLines, 'tok-new');

    // Let the old child's 300 ms SIGTERM-ignore window elapse fully, then
    // assert its straggler line never reached the client stream.
    await sleep(450);
    expect(outLines.some((l) => l.includes('straggler'))).toBe(false);

    stdin.end();
    await done;
  });

  it('fails fast (no hang) when the freshly-spawned child dies mid-swap, propagating its exit code', async () => {
    const { stdin, stdout, outLines } = makeStreams();
    const originalExitCode = process.exitCode;
    let calls = 0;
    const spawnSpec = async (): Promise<ProxyChildSpec> => {
      calls += 1;
      if (calls === 1) {
        return {
          command: process.execPath,
          args: [FIXTURE],
          env: { FAKE_TOKEN: 'tok-old', INSTANCE_TAG: 'instance-1' },
        };
      }
      // Replacement child dies immediately — before it can answer the
      // replayed initialize.
      return { command: process.execPath, args: ['-e', 'process.exit(7)'], env: {} };
    };
    let restart = false;
    const proxy = new RestartableStdioProxy({
      spawnSpec,
      shouldRestartNow: () => restart,
      stdin,
      stdout,
    });
    const done = proxy.start();

    send(stdin, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitForId(outLines, 1);

    restart = true;
    send(stdin, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await waitForId(outLines, 2); // completed response → triggers the swap

    // The proxy must END (resolve start()) with the dead child's code —
    // never hang. Timeout guard: fail loudly instead of hanging the suite.
    await Promise.race([
      done,
      sleep(5000).then(() => {
        throw new Error('proxy.start() did not resolve after mid-swap child death');
      }),
    ]);

    expect(process.exitCode).toBe(7);
    process.exitCode = originalExitCode;
    stdin.end();
  });

  it('forwards a post-swap client response that reuses the ORIGINAL initialize id (nothing legitimately swallowed)', async () => {
    const { stdin, stdout, outLines } = makeStreams();
    const { spawnSpec } = spawnSpecFactory(['tok-old', 'tok-new']);
    let restart = false;
    const proxy = new RestartableStdioProxy({
      spawnSpec,
      shouldRestartNow: () => restart,
      stdin,
      stdout,
    });
    const done = proxy.start();

    send(stdin, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitForId(outLines, 1);

    restart = true;
    send(stdin, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await waitForId(outLines, 2); // completed response → triggers the swap
    await waitForToken(stdin, outLines, 'tok-new');

    // MCP clients recycle request ids across a session. A post-swap request
    // that reuses the original initialize id (1) must get its response
    // forwarded — only the proxy's own replayed initialize (sentinel id) may
    // be swallowed.
    expect(countId(outLines, 1)).toBe(1); // just the original initialize response so far
    send(stdin, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const start = Date.now();
    for (;;) {
      if (countId(outLines, 1) === 2) break;
      if (Date.now() - start > 3000) {
        throw new Error(`post-swap response with reused id 1 never arrived; saw ${JSON.stringify(outLines)}`);
      }
      await sleep(15);
    }
    const responses = parsedLines(outLines).filter((l) => l.id === 1);
    expect(responses[1]?.result?.tools?.[0]?.token).toBe('tok-new');

    stdin.end();
    await done;
  });

  it('removes a cancelled request from in-flight tracking so a restart is not blocked forever', async () => {
    const { stdin, stdout, outLines } = makeStreams();
    const { spawnSpec } = spawnSpecFactory(['tok-old', 'tok-new']);
    let restart = false;
    const proxy = new RestartableStdioProxy({
      spawnSpec,
      shouldRestartNow: () => restart,
      stdin,
      stdout,
    });
    const done = proxy.start();

    send(stdin, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitForId(outLines, 1);

    // id 2 goes in-flight and is NEVER answered (the fixture holds it) —
    // per MCP, after notifications/cancelled the server SHOULD NOT reply.
    send(stdin, { jsonrpc: '2.0', id: 2, method: 'hold', params: {} });
    await sleep(100); // let the hold request land before cancelling it
    send(stdin, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });

    restart = true;
    // The cancelled id must no longer count as in-flight: the next completed
    // response must be able to trigger the swap.
    await waitForToken(stdin, outLines, 'tok-new');

    stdin.end();
    await done;
  });

  it('leaves the healthy old child running when the token fetch fails, then retries and succeeds', async () => {
    const { stdin, stdout, outLines } = makeStreams();
    let calls = 0;
    const spawnSpec = async (): Promise<ProxyChildSpec> => {
      calls += 1;
      if (calls === 2) throw new Error('broker unreachable'); // first RESTART attempt fails
      return {
        command: process.execPath,
        args: [FIXTURE],
        env: {
          FAKE_TOKEN: calls === 1 ? 'tok-old' : 'tok-new',
          INSTANCE_TAG: `instance-${calls}`,
        },
      };
    };
    let restart = false;
    const proxy = new RestartableStdioProxy({
      spawnSpec,
      shouldRestartNow: () => restart,
      stdin,
      stdout,
    });
    const done = proxy.start();

    send(stdin, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitForId(outLines, 1);

    restart = true;
    send(stdin, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await waitForId(outLines, 2); // completed response → triggers the FAILING restart attempt

    // The failed token fetch must leave the old child untouched: it still
    // answers (and the process must not die on an unhandled rejection).
    await sleep(150);
    send(stdin, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const resp3 = await waitForId(outLines, 3);
    expect(resp3.result?.tools?.[0]?.token).toBe('tok-old');

    // Subsequent opportunities (each completed probe response) retry the
    // swap, which now succeeds.
    await waitForToken(stdin, outLines, 'tok-new');
    expect(calls).toBeGreaterThanOrEqual(3);

    stdin.end();
    await done;
  });
});

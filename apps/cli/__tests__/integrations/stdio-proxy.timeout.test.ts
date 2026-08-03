import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

/** A fake spawned MCP server: we control its stdout (never answering, or
 *  answering on demand). */
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

async function makeProxy(timeoutMs: number) {
  process.env.CODEAM_MCP_TOOL_TIMEOUT_MS = String(timeoutMs);
  vi.resetModules();
  const { RestartableStdioProxy } = await import('../../src/integrations/stdio-proxy');
  const child = fakeChild();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out: string[] = [];
  stdout.on('data', (d) => out.push(d.toString()));
  const proxy = new RestartableStdioProxy({
    spawnSpec: async () => ({ command: 'x', args: [], env: {} }),
    shouldRestartNow: () => false,
    stdin,
    stdout,
    spawnImpl: (() => child) as never,
  });
  void proxy.start();
  await new Promise((r) => setTimeout(r, 20)); // let start() spawn + wire readline
  return { child, stdin, out };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RestartableStdioProxy — tools/call watchdog', () => {
  it('synthesizes a JSON-RPC error when a tools/call gets no response', async () => {
    const { stdin, out } = await makeProxy(80);
    stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'tables' } }) +
        '\n',
    );
    await wait(200); // past the 80ms watchdog
    const joined = out.join('');
    expect(joined).toContain('"id":7');
    expect(joined).toContain('"error"');
    expect(joined).toMatch(/timed out/i);
  });

  it('does NOT synthesize an error when the server responds in time', async () => {
    const { child, stdin, out } = await makeProxy(300);
    stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'tables' } }) +
        '\n',
    );
    await wait(30);
    // server answers quickly
    child.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: 9, result: { content: [] } }) + '\n',
    );
    await wait(400); // past the watchdog — must NOT have fired
    const joined = out.join('');
    expect(joined).toContain('"id":9');
    expect(joined).not.toMatch(/timed out/i);
  });

  it('leaves non-tools/call requests (initialize) unbounded', async () => {
    const { stdin, out } = await makeProxy(80);
    stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
    );
    await wait(200); // past the tool watchdog — initialize is NOT watched
    expect(out.join('')).not.toMatch(/timed out/i);
  });
});

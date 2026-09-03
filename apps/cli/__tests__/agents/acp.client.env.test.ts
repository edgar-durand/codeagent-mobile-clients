import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the spawn options without launching a real adapter. The contract
// under test: AcpClientOptions.extraEnv is merged into the adapter spawn env
// (so the runner can inject CLAUDE_CODE_DISABLE_1M_CONTEXT=1 on a re-spawn).
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(
    (_cmd: string, _args: readonly string[], _opts: { env: Record<string, string> }) => {
      const stream = { on: vi.fn(), setEncoding: vi.fn(), pipe: vi.fn(), write: vi.fn(), end: vi.fn() };
      return { stdout: stream, stderr: stream, stdin: stream, on: vi.fn(), once: vi.fn(), kill: vi.fn(), pid: 4242 };
    },
  ),
}));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { AcpClient, MCP_STARTUP_TIMEOUT_MS } from '../../src/agents/acp/client';

function makeClient(extraEnv?: Record<string, string>) {
  return new AcpClient({
    adapter: { command: 'node', args: ['--acp'] },
    cwd: '/tmp',
    extraEnv,
    onSessionUpdate: vi.fn(),
    onRequestPermission: vi.fn(),
    onExit: vi.fn(),
  } as never);
}

describe('AcpClient — extraEnv reaches the adapter spawn', () => {
  beforeEach(() => spawnMock.mockClear());

  it('merges extraEnv (CLAUDE_CODE_DISABLE_1M_CONTEXT) into the spawn env', () => {
    const c = makeClient({ CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' });
    // start() spawns synchronously up-front; the connection handshake that
    // follows rejects against the fake child — we only care about the spawn.
    void c.start().catch(() => undefined);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0][2];
    expect(opts.env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('1');
    // PATH is still present (augmented), proving extraEnv didn't clobber it.
    expect(typeof opts.env.PATH).toBe('string');
  });

  it('omits the knob when no extraEnv is given (default path unaffected)', () => {
    const c = makeClient();
    void c.start().catch(() => undefined);
    const opts = spawnMock.mock.calls[0][2];
    expect(opts.env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBeUndefined();
  });
});

// ⚠️ This is not a preference — the agent's DEFAULT is 30 s per MCP server,
// measured across `session/new`, where it starts every advertised server at
// once. Our servers are the `codeam mcp-run` shim: provision a launcher, broker
// a credential over HTTPS, then `npx` the vendor's server (a download, first
// time), times every linked integration, racing on one core. On a real box that
// left clickup/trello/postman answering `Server "clickup" is not connected` for
// the whole session with no retry, while `session/new` itself reported ok
// (rafaelph90.br@gmail.com, 2026-09-03 — see MCP_STARTUP_TIMEOUT_MS).
describe('AcpClient — the agent gets an MCP startup budget that fits our shim', () => {
  beforeEach(() => spawnMock.mockClear());

  it('hands MCP_TIMEOUT to the adapter even with no extraEnv', () => {
    const c = makeClient();
    void c.start().catch(() => undefined);
    const opts = spawnMock.mock.calls[0][2];
    expect(opts.env.MCP_TIMEOUT).toBe(String(MCP_STARTUP_TIMEOUT_MS));
    // The whole point: comfortably above the agent's own 30 s default...
    expect(MCP_STARTUP_TIMEOUT_MS).toBeGreaterThan(30_000);
    // ...and still BELOW our own `newSession` ceiling (120 s), or a slow server
    // would make us abort the handshake instead of getting a session that is
    // merely missing that one server. It is derived from that ceiling for this
    // reason; the assertion is here so raising one without the other fails.
    expect(MCP_STARTUP_TIMEOUT_MS).toBeLessThan(120_000);
  });

  it('lets an explicit extraEnv value win, so a box can still tune it', () => {
    const c = makeClient({ MCP_TIMEOUT: '45000' });
    void c.start().catch(() => undefined);
    const opts = spawnMock.mock.calls[0][2];
    expect(opts.env.MCP_TIMEOUT).toBe('45000');
  });
});

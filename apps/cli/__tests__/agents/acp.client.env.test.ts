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

import { AcpClient } from '../../src/agents/acp/client';

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

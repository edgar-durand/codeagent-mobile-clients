import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/spawn-and-capture', () => ({
  spawnAndCapture: vi.fn(async () => 'ok'),
}));
vi.mock('../../src/agents/claude/resolver', () => ({
  buildClaudeLaunch: vi.fn((args: string[]) => ({ cmd: '/usr/bin/claude', args })),
}));

import { spawnAndCapture } from '../../src/services/spawn-and-capture';
import { ClaudeRuntimeStrategy } from '../../src/agents/claude/runtime';
import { LinuxOsStrategy } from '../../src/os';
import { readOneShotConversations } from '../../src/services/oneshot-registry';

/**
 * A `claude -p` one-shot writes `<session-id>.jsonl` into the session's project
 * dir. Pre-minting the id and registering it lets RECENT, the history detector
 * and the resume pick skip the transcript.
 */
describe('ClaudeRuntimeStrategy.generateOneShot', () => {
  const prevHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = prevHome;
  });

  it('runs claude -p with a pre-minted --session-id registered for the cwd before spawning', async () => {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-oneshot-home-'));
    const cwd = '/tmp/oneshot-project';
    const spawn = vi.mocked(spawnAndCapture);
    let registeredAtSpawn: Set<string> | null = null;
    spawn.mockImplementationOnce(async () => {
      registeredAtSpawn = readOneShotConversations(cwd);
      return 'ok';
    });

    const out = await new ClaudeRuntimeStrategy(new LinuxOsStrategy()).generateOneShot('hi', {
      cwd,
    });

    expect(out).toBe('ok');
    const [cmd, args, opts] = spawn.mock.calls[0];
    expect(cmd).toBe('/usr/bin/claude');
    expect(args.slice(0, 3)).toEqual(['-p', 'hi', '--session-id']);
    const id = args[3];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(opts?.cwd).toBe(cwd);
    expect(registeredAtSpawn).not.toBeNull();
    expect(registeredAtSpawn!.has(id)).toBe(true);
  });
});

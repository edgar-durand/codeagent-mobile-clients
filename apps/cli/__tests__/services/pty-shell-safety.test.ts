import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process.spawn so we can inspect how UnixPtyStrategy invokes it
vi.mock('child_process', () => {
  const fakeStream = {
    on: vi.fn(),
    once: vi.fn(),
    pipe: vi.fn(),
    removeListener: vi.fn(),
    write: vi.fn(),
  };
  return {
    spawn: vi.fn(() => ({
      stdout: fakeStream,
      stderr: fakeStream,
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn(),
      once: vi.fn(),
      removeAllListeners: vi.fn(),
      kill: vi.fn(),
      pid: 1234,
      killed: false,
    })),
  };
});

// Mock fs.writeFileSync so we don't actually write the helper script
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    accessSync: vi.fn(), // makes findInPath always succeed → returns first PATH dir
  };
});

import { spawn } from 'child_process';
import { UnixPtyStrategy } from '../../src/services/pty/unix.strategy';

describe('UnixPtyStrategy argv handling (shell-injection safety)', () => {
  beforeEach(() => {
    (spawn as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    // Some code paths attach process.stdin / SIGWINCH listeners — drop them.
    process.stdin.removeAllListeners('data');
    process.removeAllListeners('SIGWINCH');
  });

  test('passes args as discrete argv elements with shell:false (no /bin/sh -c concatenation)', () => {
    const strat = new UnixPtyStrategy({
      onData: () => {},
      onExit: () => {},
    });

    // Args contain shell metacharacters that must NOT be interpreted by /bin/sh
    strat.spawn('claude', '/tmp', ['--resume', 'sess; rm -rf /', '$(touch pwn)']);

    const calls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);

    const lastCall = calls[calls.length - 1];
    const argv = lastCall[1] as string[];
    const opts = lastCall[2] as { shell?: boolean | string };

    // shell must NOT be true (false or omitted are both fine)
    expect(opts?.shell).not.toBe(true);

    // Each metachar-laden arg must appear as a discrete argv element
    expect(argv).toContain('--resume');
    expect(argv).toContain('sess; rm -rf /');
    expect(argv).toContain('$(touch pwn)');

    // Negative: no single argv element contains the dangerous shell concatenation
    const dangerous = 'claude --resume sess; rm -rf / $(touch pwn)';
    expect(argv.some((a) => a === dangerous)).toBe(false);

    // Negative: no `-c` flag with a concatenated command string is passed
    const cIdx = argv.indexOf('-c');
    if (cIdx >= 0) {
      const concatenated = argv[cIdx + 1] ?? '';
      expect(concatenated).not.toMatch(/sess; rm -rf \/|\$\(touch pwn\)/);
    }

    strat.dispose();
  });

  test('spawn() with no extra args still works and does not enable shell:true', () => {
    const strat = new UnixPtyStrategy({
      onData: () => {},
      onExit: () => {},
    });

    strat.spawn('claude', '/tmp');

    const calls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const opts = calls[calls.length - 1][2] as { shell?: boolean | string };
    expect(opts?.shell).not.toBe(true);

    strat.dispose();
  });
});

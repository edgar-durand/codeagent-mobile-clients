/**
 * runNpmInstallLatest — Windows .cmd spawn regression (bd codeagent-5bb).
 *
 * npm on Windows is a .cmd shim, and patched Node (CVE-2024-27980,
 * ≥18.20.2/20.12.2) throws EINVAL when spawning .cmd/.bat without a shell —
 * so `cli_self_update` could never actually run npm on a real Windows box.
 * These tests pin the fix: shell on win32 (with the command quoted when the
 * path has spaces, e.g. C:\Program Files\nodejs\npm.cmd), NO shell on POSIX.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: execFileMock };
});

import { runNpmInstallLatest } from '../../../src/commands/start/handlers';

const realPlatform = process.platform;

function stubPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  execFileMock.mockReset();
});

function succeedOnCall() {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: object,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, '', '');
    },
  );
}

describe('runNpmInstallLatest — shell usage per platform (codeagent-5bb)', () => {
  it('win32: uses a shell so the npm .cmd shim can spawn on patched Node', async () => {
    stubPlatform('win32');
    succeedOnCall();

    const res = await runNpmInstallLatest();

    expect(res.ok).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, , opts] = execFileMock.mock.calls[0] as [string, string[], { shell?: boolean }];
    expect(opts.shell).toBe(true);
  });

  it('win32: quotes the command when its path contains spaces', async () => {
    stubPlatform('win32');
    succeedOnCall();

    await runNpmInstallLatest();

    const [cmd] = execFileMock.mock.calls[0] as [string];
    // Whatever buildNpmInstallInvocation resolved, a spaced path must arrive
    // quoted for cmd.exe; an unspaced one must arrive verbatim.
    if (cmd.includes(' ')) {
      expect(cmd.startsWith('"') && cmd.endsWith('"')).toBe(true);
    } else {
      expect(cmd.includes('"')).toBe(false);
    }
  });

  it('POSIX: no shell — direct execFile exactly as before', async () => {
    stubPlatform('linux');
    succeedOnCall();

    const res = await runNpmInstallLatest();

    expect(res.ok).toBe(true);
    const [cmd, , opts] = execFileMock.mock.calls[0] as [string, string[], { shell?: boolean }];
    expect(opts.shell).toBe(false);
    expect(cmd.includes('"')).toBe(false);
  });
});

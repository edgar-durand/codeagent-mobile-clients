import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findInPath as legacyFindInPath } from '../../src/services/pty/types';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DarwinOsStrategy,
  LinuxOsStrategy,
  Win32OsStrategy,
  createOsStrategy,
  _resetOsStrategyCacheForTests,
} from '../../src/os';

/**
 * OsStrategy contract test.
 *
 * Each per-platform impl is instantiable on any host — the strategy
 * tests do NOT consult `process.platform`. That's what makes this
 * suite useful on a macOS dev box: we cover the Win32 branch as
 * thoroughly as the POSIX branches without needing a Windows runner.
 *
 * For PATH-probing tests we sandbox PATH to a tmp dir of our own
 * making so the host's actual installed binaries don't interfere.
 */

describe('OsStrategy', () => {
  describe('id', () => {
    it.each([
      ['darwin', new DarwinOsStrategy()],
      ['linux', new LinuxOsStrategy()],
      ['win32', new Win32OsStrategy()],
    ] as const)('reports id=%s', (id, strat) => {
      expect(strat.id).toBe(id);
    });
  });

  describe('devNull', () => {
    it.each([
      [new DarwinOsStrategy(), '/dev/null'],
      [new LinuxOsStrategy(), '/dev/null'],
      [new Win32OsStrategy(), 'NUL'],
    ])('returns the OS-native null device', (strat, expected) => {
      expect(strat.devNull()).toBe(expected);
    });
  });

  describe('homeDir', () => {
    it('returns os.homedir()', () => {
      expect(new DarwinOsStrategy().homeDir()).toBe(os.homedir());
      expect(new LinuxOsStrategy().homeDir()).toBe(os.homedir());
      expect(new Win32OsStrategy().homeDir()).toBe(os.homedir());
    });
  });

  describe('scratchPath', () => {
    it.each([
      [new DarwinOsStrategy()],
      [new LinuxOsStrategy()],
      [new Win32OsStrategy()],
    ])('produces a unique path under tmpdir on each call', (strat) => {
      const a = strat.scratchPath('codeam-test');
      const b = strat.scratchPath('codeam-test');
      expect(a).not.toBe(b);
      expect(a.startsWith(os.tmpdir())).toBe(true);
      expect(path.basename(a)).toMatch(/^codeam-test-\d+-[0-9a-f]{8}$/);
    });
  });

  describe('augmentPath', () => {
    const ORIGINAL = process.env.PATH;
    beforeEach(() => {
      process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
    });
    afterEach(() => {
      process.env.PATH = ORIGINAL;
    });

    it('prepends a single dir using : on POSIX', () => {
      new LinuxOsStrategy().augmentPath(['/opt/extra/bin']);
      expect(process.env.PATH).toBe('/opt/extra/bin:/usr/local/bin:/usr/bin:/bin');
    });

    it('uses ; on Windows', () => {
      process.env.PATH = 'C:\\Windows;C:\\Windows\\System32';
      new Win32OsStrategy().augmentPath(['C:\\tools']);
      expect(process.env.PATH).toBe('C:\\tools;C:\\Windows;C:\\Windows\\System32');
    });

    it('is idempotent when the dir is already in PATH (POSIX)', () => {
      const before = process.env.PATH;
      new LinuxOsStrategy().augmentPath(['/usr/bin']);
      expect(process.env.PATH).toBe(before);
    });

    it('case-insensitive de-dup on Windows', () => {
      process.env.PATH = 'C:\\Windows;C:\\tools';
      // Mix the case — must not double-add.
      new Win32OsStrategy().augmentPath(['c:\\TOOLS']);
      expect(process.env.PATH).toBe('C:\\Windows;C:\\tools');
    });

    it('no-op when given an empty array', () => {
      const before = process.env.PATH;
      new LinuxOsStrategy().augmentPath([]);
      expect(process.env.PATH).toBe(before);
    });
  });

  describe('findInPath', () => {
    // Build a temp dir, drop a fake binary in it, scope PATH to it,
    // verify each strategy resolves it the right way.
    let tmpDir: string;
    const ORIGINAL_PATH = process.env.PATH;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-test-path-'));
    });
    afterEach(() => {
      process.env.PATH = ORIGINAL_PATH;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('POSIX: resolves an executable binary, returns null for non-exec files', () => {
      const okPath = path.join(tmpDir, 'ok');
      fs.writeFileSync(okPath, '#!/bin/sh\necho ok\n', { mode: 0o755 });
      const notExecPath = path.join(tmpDir, 'noexec');
      fs.writeFileSync(notExecPath, 'data', { mode: 0o644 });

      process.env.PATH = tmpDir;
      const strat = new LinuxOsStrategy();
      expect(strat.findInPath('ok')).toBe(okPath);
      // 0o644 → X_OK fails → no match.
      expect(strat.findInPath('noexec')).toBeNull();
      expect(strat.findInPath('missing-binary')).toBeNull();
    });

    it('POSIX: does NOT fan out PATHEXT — name is name', () => {
      // Drop a file named `foo.exe` in the tmp dir; POSIX should
      // NOT find it when we ask for `foo`.
      fs.writeFileSync(path.join(tmpDir, 'foo.exe'), '#!/bin/sh\n', { mode: 0o755 });
      process.env.PATH = tmpDir;
      expect(new LinuxOsStrategy().findInPath('foo')).toBeNull();
      // Asking for `foo.exe` directly works though.
      expect(new LinuxOsStrategy().findInPath('foo.exe')).toBe(
        path.join(tmpDir, 'foo.exe'),
      );
    });

    it('Win32: probes .exe, .cmd, .bat, .ps1 in that order', () => {
      // Drop both .cmd and .exe; .exe must win (first candidate).
      fs.writeFileSync(path.join(tmpDir, 'tool.exe'), 'exe');
      fs.writeFileSync(path.join(tmpDir, 'tool.cmd'), 'cmd');
      process.env.PATH = tmpDir;
      // Win32 uses ; — set up the PATH that way.
      // (Our beforeEach didn't enforce a delimiter; we just pointed PATH at tmpDir.)
      const strat = new Win32OsStrategy();
      const found = strat.findInPath('tool');
      // On a non-Windows host the delimiter the strategy splits on is
      // still `path.delimiter` (which is `;` on Win, `:` elsewhere).
      // So this assertion only holds when running on Windows — skip if
      // not. We'll cover Win32 PATH-split behaviour separately.
      if (process.platform === 'win32') {
        expect(found).toBe(path.join(tmpDir, 'tool.exe'));
      } else {
        // Non-win host: `path.delimiter` is `:`, so splitting on ; means
        // tmpDir matches as a single dir. findInPath should still find
        // `tool.exe` (first candidate).
        expect(found).toBe(path.join(tmpDir, 'tool.exe'));
      }
    });

    it('Win32: bare name with explicit extension is not re-probed', () => {
      fs.writeFileSync(path.join(tmpDir, 'tool.exe'), 'data');
      process.env.PATH = tmpDir;
      // Asking for `tool.bat` must NOT silently resolve to `tool.exe`.
      const strat = new Win32OsStrategy();
      expect(strat.findInPath('tool.bat')).toBeNull();
      expect(strat.findInPath('tool.exe')).toBe(path.join(tmpDir, 'tool.exe'));
    });
  });

  describe('escapeShellArg', () => {
    it('POSIX: empty string still quoted', () => {
      expect(new LinuxOsStrategy().escapeShellArg('')).toBe(`''`);
    });

    it('POSIX: simple alpha leaves no escaping (still quoted for safety)', () => {
      expect(new LinuxOsStrategy().escapeShellArg('hello')).toBe(`'hello'`);
    });

    it('POSIX: embedded single-quote uses the escape-out / re-enter idiom', () => {
      // Input:  it's
      // Output: 'it'\''s'
      expect(new LinuxOsStrategy().escapeShellArg(`it's`)).toBe(`'it'\\''s'`);
    });

    it('POSIX: path with spaces', () => {
      expect(new LinuxOsStrategy().escapeShellArg(`/path with spaces/bin`)).toBe(
        `'/path with spaces/bin'`,
      );
    });

    it('Win32: alphanumeric arg unquoted', () => {
      expect(new Win32OsStrategy().escapeShellArg('hello')).toBe('hello');
    });

    it('Win32: arg with space gets double-quoted', () => {
      expect(new Win32OsStrategy().escapeShellArg(`C:\\Program Files\\app`)).toBe(
        `"C:\\Program Files\\app"`,
      );
    });

    it('Win32: cmd metachars caret-escaped inside quotes', () => {
      // & | ^ < > ( ) % ! all need ^-escape so cmd.exe doesn't expand.
      expect(new Win32OsStrategy().escapeShellArg('a&b|c')).toBe(`"a^&b^|c"`);
    });

    it('Win32: backslashes before embedded quotes double up', () => {
      // Input:  a\"b  → must produce a\\\"b inside quotes.
      // The Microsoft C runtime parser reads `\"` as a literal `"`,
      // and `\\` as a literal `\`. So to ship a literal `\"` to the
      // child we send `\\\"`.
      expect(new Win32OsStrategy().escapeShellArg('a\\"b')).toBe(`"a\\\\\\"b"`);
    });
  });
});

describe('OsStrategy.buildLaunch', () => {
  describe('POSIX', () => {
    const strat = new LinuxOsStrategy();

    it('returns (binary, args) verbatim — execve handles shebangs', () => {
      expect(strat.buildLaunch('/usr/local/bin/claude', ['--resume', 'abc'])).toEqual({
        cmd: '/usr/local/bin/claude',
        args: ['--resume', 'abc'],
      });
    });

    it('handles empty extraArgs', () => {
      expect(strat.buildLaunch('/bin/sh')).toEqual({ cmd: '/bin/sh', args: [] });
    });

    it('does NOT wrap .cmd/.ps1 — those are Windows-only', () => {
      // A binary named foo.cmd on Linux is still just a file; we
      // don't second-guess the user. (Real Linux installs of agents
      // wouldn't have .cmd suffixes, but the contract is "spawn what
      // you were told".)
      expect(new LinuxOsStrategy().buildLaunch('/opt/strange.cmd')).toEqual({
        cmd: '/opt/strange.cmd',
        args: [],
      });
    });
  });

  describe('Win32', () => {
    const strat = new Win32OsStrategy();

    it('.exe runs directly', () => {
      const result = strat.buildLaunch('C:\\bin\\claude.exe', ['--resume', 'abc']);
      expect(result).toEqual({
        cmd: 'C:\\bin\\claude.exe',
        args: ['--resume', 'abc'],
      });
    });

    it('.cmd wraps with cmd.exe /c', () => {
      const result = strat.buildLaunch('C:\\bin\\claude.cmd', ['--resume', 'abc']);
      expect(result).toEqual({
        cmd: 'cmd.exe',
        args: ['/c', 'C:\\bin\\claude.cmd', '--resume', 'abc'],
      });
    });

    it('.bat wraps the same as .cmd', () => {
      const result = strat.buildLaunch('C:\\bin\\claude.bat');
      expect(result).toEqual({
        cmd: 'cmd.exe',
        args: ['/c', 'C:\\bin\\claude.bat'],
      });
    });

    it('.ps1 wraps with powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File', () => {
      const result = strat.buildLaunch('C:\\bin\\claude.ps1', ['--resume', 'abc']);
      expect(result).toEqual({
        cmd: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          'C:\\bin\\claude.ps1',
          '--resume',
          'abc',
        ],
      });
    });

    it('extension-less binary runs directly', () => {
      // Rare on Windows but possible (some hand-rolled installers).
      const result = strat.buildLaunch('C:\\bin\\claude');
      expect(result).toEqual({
        cmd: 'C:\\bin\\claude',
        args: [],
      });
    });

    it('extension case-insensitive — .CMD treated as .cmd', () => {
      const result = strat.buildLaunch('C:\\bin\\claude.CMD');
      expect(result).toEqual({
        cmd: 'cmd.exe',
        args: ['/c', 'C:\\bin\\claude.CMD'],
      });
    });
  });
});

describe('createOsStrategy', () => {
  beforeEach(() => _resetOsStrategyCacheForTests());
  afterEach(() => _resetOsStrategyCacheForTests());

  it('memoises across calls', () => {
    const a = createOsStrategy();
    const b = createOsStrategy();
    expect(a).toBe(b);
  });

  it('matches the host platform', () => {
    const strat = createOsStrategy();
    const expected =
      process.platform === 'darwin'
        ? 'darwin'
        : process.platform === 'win32'
        ? 'win32'
        : 'linux';
    expect(strat.id).toBe(expected);
  });
});

describe('findInPath backward-compat re-export', () => {
  it('still works via services/pty/types', () => {
    // Drop a temp file + scope PATH; the legacy export must still find it.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-test-compat-'));
    try {
      const file = path.join(tmpDir, 'shim');
      fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
      const originalPath = process.env.PATH;
      process.env.PATH = tmpDir;
      try {
        if (process.platform === 'win32') {
          // Win32 host: requires extension; skip the POSIX assertion.
          expect(legacyFindInPath('shim')).toBeNull();
        } else {
          expect(legacyFindInPath('shim')).toBe(file);
        }
      } finally {
        process.env.PATH = originalPath;
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

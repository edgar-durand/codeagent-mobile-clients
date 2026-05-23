import { describe, test, expect } from 'vitest';
import { buildInstallAndRun } from '../src/utils/build-install-command';

/**
 * Cross-OS coverage for the install-then-run one-liner the
 * "Pair from mobile" / "Link agent" flows send to the freshly-opened
 * IDE terminal. The job runs on ubuntu-latest AND windows-latest
 * (see `.github/workflows/ci.yml`'s `vsc-plugin` matrix), but the
 * pure function takes the platform + shell as inputs so a single
 * runner exercises every combination deterministically.
 *
 * Background — what we're guarding against (v2.17.x regression):
 *
 *   `npm install -g codeam-cli@latest && codeam pair || npx -y …`
 *
 * `&&` and `||` as pipeline-chain operators were only added in
 * PowerShell 7. PowerShell 5.x — the default shell on every fresh
 * Windows 10/11 install, and the one VS Code picks up via
 * `vscode.env.shell` when the user hasn't installed PS 7 — parses
 * `&&` as an "invalid statement separator" and the command dies
 * before npm runs. We caught it on a Windows Pair From Mobile flow:
 * the terminal opened and the user saw a PowerShell ParserError
 * instead of a paired session.
 *
 * The fix detects PS 5.x specifically (path ends in
 * `…WindowsPowerShell\v1.0\powershell.exe`, NOT pwsh.exe) and emits
 * the semicolon + `$LASTEXITCODE` equivalent that works in PS 5.x
 * AND PS 7+. The tests below pin every relevant shell so any future
 * tweak to the detection / emit logic that drops PS 5.x support is
 * caught at CI time, before a tag.
 */
describe('buildInstallAndRun', () => {
  const REAL_PS5_PATH =
    'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const REAL_PS7_PATH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const REAL_CMD_PATH = 'C:\\WINDOWS\\System32\\cmd.exe';
  const REAL_BASH_PATH = '/bin/bash';
  const REAL_ZSH_PATH = '/bin/zsh';

  describe('Windows', () => {
    test('PowerShell 5.x — emits semicolon + $LASTEXITCODE (avoids the && parse error)', () => {
      const out = buildInstallAndRun('pair', REAL_PS5_PATH, true);
      expect(out).toContain('npm install -g codeam-cli@latest;');
      expect(out).toContain('if ($LASTEXITCODE -eq 0)');
      expect(out).toContain('codeam pair');
      expect(out).toContain('npx -y codeam-cli@latest pair');
      // The whole command must not use && / || on PS 5.x.
      expect(out).not.toContain('&&');
      expect(out).not.toContain('||');
    });

    test('PowerShell 5.x — detection is case-insensitive (Windows paths)', () => {
      const out = buildInstallAndRun(
        'pair',
        REAL_PS5_PATH.toUpperCase(),
        true,
      );
      expect(out).toContain('if ($LASTEXITCODE -eq 0)');
      expect(out).not.toContain('&&');
    });

    test('PowerShell 7+ (pwsh) — keeps the && / || one-liner', () => {
      const out = buildInstallAndRun('pair', REAL_PS7_PATH, true);
      expect(out).toBe(
        'npm install -g codeam-cli@latest && codeam pair || npx -y codeam-cli@latest pair',
      );
    });

    test('cmd.exe — keeps the && / || one-liner (cmd.exe supports both)', () => {
      const out = buildInstallAndRun('pair', REAL_CMD_PATH, true);
      expect(out).toBe(
        'npm install -g codeam-cli@latest && codeam pair || npx -y codeam-cli@latest pair',
      );
    });

    test('Unknown shell on Windows — falls back to && / || (last-resort same as Unix)', () => {
      const out = buildInstallAndRun('pair', '', true);
      expect(out).toContain('&&');
      expect(out).toContain('||');
    });
  });

  describe('macOS / Linux', () => {
    test('bash — keeps the && / || one-liner', () => {
      const out = buildInstallAndRun('pair', REAL_BASH_PATH, false);
      expect(out).toBe(
        'npm install -g codeam-cli@latest && codeam pair || npx -y codeam-cli@latest pair',
      );
    });

    test('zsh — keeps the && / || one-liner', () => {
      const out = buildInstallAndRun('pair', REAL_ZSH_PATH, false);
      expect(out).toBe(
        'npm install -g codeam-cli@latest && codeam pair || npx -y codeam-cli@latest pair',
      );
    });

    test('shellHint with PS5-shaped suffix but isWindows=false — does NOT trigger PS5 branch', () => {
      // Defence-in-depth: even if a user's `vscode.env.shell` returned
      // something that ended in `powershell.exe` on a Mac (impossible
      // in practice, but the function only knows what we feed it),
      // the macOS terminal would NOT run PowerShell syntax. The
      // `isWindows` gate is the primary filter.
      const out = buildInstallAndRun(
        'pair',
        '/opt/weird/path/powershell.exe',
        false,
      );
      expect(out).toContain('&&');
    });
  });

  describe('subcommand pass-through', () => {
    test('link claude — both branches embed the verb', () => {
      const win = buildInstallAndRun('link claude', REAL_PS5_PATH, true);
      expect(win).toContain('codeam link claude');
      expect(win).toContain('npx -y codeam-cli@latest link claude');

      const unix = buildInstallAndRun('link claude', REAL_BASH_PATH, false);
      expect(unix).toContain('codeam link claude');
      expect(unix).toContain('npx -y codeam-cli@latest link claude');
    });

    test('link codex — same shape, different agent', () => {
      const out = buildInstallAndRun('link codex', REAL_PS5_PATH, true);
      expect(out).toContain('codeam link codex');
      expect(out).toContain('npx -y codeam-cli@latest link codex');
    });
  });
});

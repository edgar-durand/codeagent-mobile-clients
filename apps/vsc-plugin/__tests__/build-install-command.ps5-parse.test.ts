import { describe, test, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { buildInstallAndRun } from '../src/utils/build-install-command';

/**
 * Real PowerShell parser-level validation. The shape-based tests in
 * the sibling `build-install-command.test.ts` file only check the
 * STRING we generate — they don't catch the bug they were written to
 * prevent (a Windows-PowerShell-5 ParserError on the chained command).
 *
 * This test invokes the actual PowerShell parser on the matrix's
 * windows-latest runner via:
 *
 *     pwsh -NoProfile -NoLogo -Command "[scriptblock]::Create('<cmd>')"
 *
 * `[scriptblock]::Create(...)` parses the script WITHOUT executing
 * it. A ParserError throws synchronously and bubbles out as a non-
 * zero exit code, which `execSync` surfaces as a thrown exception.
 * Exit 0 means PowerShell can run the command cleanly. That's what
 * we actually care about — not "does the string look right".
 *
 * Runs on the `windows-latest` job only (skipped elsewhere — Linux
 * runners don't ship PowerShell by default and we don't need to
 * validate Linux shells against a Windows-specific parser).
 */
const isWindows = process.platform === 'win32';

describe.runIf(isWindows)('buildInstallAndRun — real PowerShell parser', () => {
  const REAL_PS5_PATH =
    'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

  function assertParsesCleanly(cmd: string): void {
    // Embed the command as a single-quoted PS literal — PowerShell
    // single quotes don't expand variables, only need to escape `'`
    // as `''`. We don't generate any single-quoted strings ourselves
    // so this is safe.
    const escaped = cmd.replace(/'/g, "''");
    // Use `[scriptblock]::Create` so the parser runs but the script
    // doesn't execute. Print 'OK' on success so we can grep for it.
    const psScript = `[scriptblock]::Create('${escaped}') | Out-Null; 'OK'`;
    // Prefer pwsh (PS 7+) if available — modern Windows CI runners
    // ship it — and fall back to legacy `powershell.exe` (PS 5.x).
    // Either parser correctly rejects `&&`/`||` in PS 5 syntax, so
    // both shells produce the right pass/fail signal for our case.
    const shells = ['pwsh', 'powershell'];
    let lastErr: unknown;
    for (const shell of shells) {
      try {
        const out = execSync(
          `${shell} -NoProfile -NoLogo -Command "${psScript.replace(/"/g, '`"')}"`,
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        expect(out.trim()).toBe('OK');
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('no PowerShell available on PATH');
  }

  test('PS5 form (pair) parses without errors', () => {
    const cmd = buildInstallAndRun('pair', REAL_PS5_PATH, true);
    assertParsesCleanly(cmd);
  });

  test('PS5 form (link claude) parses without errors', () => {
    const cmd = buildInstallAndRun('link claude', REAL_PS5_PATH, true);
    assertParsesCleanly(cmd);
  });

  test('PS5 form (link codex) parses without errors', () => {
    const cmd = buildInstallAndRun('link codex', REAL_PS5_PATH, true);
    assertParsesCleanly(cmd);
  });

  test('Regression — the original buggy form WAS rejected by PS5 parser', () => {
    // Belt-and-braces: confirm the legacy `A && B || C` string PS5
    // can't parse really does fail. If this ever starts PASSING,
    // either PowerShell has been updated (we should re-check assumptions)
    // or the parser is silently swallowing the error (this test got
    // useless — investigate). Either way, we want a signal.
    const legacy =
      'npm install -g codeam-cli@latest && codeam pair || npx -y codeam-cli@latest pair';
    expect(() => assertParsesCleanly(legacy)).toThrow();
  });
});

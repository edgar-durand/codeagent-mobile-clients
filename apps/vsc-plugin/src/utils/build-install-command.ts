/**
 * Build the install-then-run one-liner sent to a freshly-opened
 * IDE terminal for `install_cli_and_pair` / `install_cli_and_link`.
 *
 * Two callers in `panels/controller-panel.ts`, kept here as a pure
 * function so the CI matrix can validate the cross-shell behaviour
 * (ubuntu-latest + windows-latest) without spinning up a VS Code
 * extension host.
 *
 * Shell semantics — what works where:
 *
 *   bash / zsh / fish / pwsh 7+ / cmd.exe : `&&` and `||` chain
 *     commands by exit code
 *   Windows PowerShell 5.x                  : `&&` / `||` were only
 *     added in PowerShell 7 (Sept 2020). PS 5.x parses them as an
 *     "invalid statement separator" and the whole pipeline dies
 *     before `npm` even runs.
 *
 * PowerShell 5.x is the default on every fresh Windows 10/11 box and
 * is what VS Code picks up via `vscode.env.shell` when the user
 * hasn't installed PS 7. Detect by suffix:
 *
 *   PS 5.x  : `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`
 *   PS 7+   : `C:\Program Files\PowerShell\7\pwsh.exe`
 *
 * For PS 5.x we emit semicolon + `$LASTEXITCODE`, which IS supported
 * in PS 5.x AND PS 7+. Everywhere else we keep the original `&&`/`||`
 * form so the npx fallback still triggers on both kinds of failure
 * (install fails because of sudo OR the install-succeed-then-pair-
 * fail edge case).
 *
 * @param subcommand  The codeam-cli verb + args, e.g. `"pair"`
 *                    or `"link codex"`.
 * @param shellHint   The detected shell path (`vscode.env.shell`).
 *                    Empty string when unknown.
 * @param isWindows   `process.platform === 'win32'`. Pre-computed
 *                    by the caller so this stays pure-functional.
 */
export function buildInstallAndRun(
  subcommand: string,
  shellHint: string,
  isWindows: boolean,
): string {
  const lowered = shellHint.toLowerCase();
  const isLegacyPowerShell =
    isWindows &&
    lowered.endsWith('powershell.exe') &&
    !lowered.endsWith('pwsh.exe');

  if (isLegacyPowerShell) {
    // Faithful PowerShell equivalent of the bash `A && B || C` chain:
    // run C (npx) if EITHER A (`npm install`) OR B (`codeam`) failed.
    // The naïve "if (install ok) { codeam } else { npx }" form misses
    // the common Windows case where `npm install -g` succeeds but the
    // freshly-installed binary isn't yet on `$env:PATH` in the same
    // shell session — `codeam pair` then fails with "not recognized"
    // and there's no fallback. Track success in a local variable and
    // dispatch to npx whenever it stays false.
    return [
      `$ok = $false;`,
      `npm install -g codeam-cli@latest;`,
      `if ($LASTEXITCODE -eq 0) { codeam ${subcommand}; if ($LASTEXITCODE -eq 0) { $ok = $true } };`,
      `if (-not $ok) { npx -y codeam-cli@latest ${subcommand} }`,
    ].join(' ');
  }

  return `npm install -g codeam-cli@latest && codeam ${subcommand} || npx -y codeam-cli@latest ${subcommand}`;
}

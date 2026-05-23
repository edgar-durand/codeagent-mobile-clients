package com.windsurf.controller.util

/**
 * Build the install-then-run one-liner sent to a freshly-opened
 * JetBrains terminal for `install_cli_and_pair` / `install_cli_and_link`.
 *
 * Two callers in `ui/ControllerToolWindowFactory.kt`. Extracted here
 * as a pure top-level function so the JUnit task can validate the
 * cross-OS behaviour without booting the IDE.
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
 * The JetBrains terminal-tool-window API doesn't expose the user's
 * configured shell path, so we can't sniff PS 5.x vs PS 7+
 * specifically. JetBrains terminals default to PowerShell on Windows
 * on every modern IDE install, and PS 5.x is the OS default until the
 * user explicitly installs PS 7, so on Windows we emit the safe
 * semicolon + `$LASTEXITCODE` form. It runs verbatim on PS 5.x AND
 * PS 7+; users still on cmd.exe lose the install-then-pair chain but
 * that's a small minority on modern JetBrains Windows installs.
 *
 * macOS / Linux / WSL keep the original `&&`/`||` form unchanged.
 *
 * @param subcommand The codeam-cli verb + args, e.g. `"pair"` or
 *                   `"link codex"`.
 * @param osName     `System.getProperty("os.name")`. Taken as a
 *                   parameter so unit tests can pin every OS.
 */
object BuildInstallCommand {
    fun forSubcommand(subcommand: String, osName: String): String {
        val isWindows = osName.startsWith("Windows", ignoreCase = true)
        return if (isWindows) {
            // Faithful PowerShell equivalent of the bash `A && B || C`
            // chain: run C (npx) if EITHER A (`npm install`) OR B
            // (`codeam`) failed. The naïve "if (install ok) { codeam }
            // else { npx }" form misses the common Windows case where
            // `npm install -g` succeeds but the freshly-installed
            // binary isn't yet on `$env:PATH` in the same shell —
            // `codeam ${subcommand}` then fails with "not recognized"
            // and there's no fallback. Track success in a local var
            // and dispatch to npx whenever it stays false.
            "\$ok = \$false; npm install -g codeam-cli@latest; if (\$LASTEXITCODE -eq 0) { codeam $subcommand; if (\$LASTEXITCODE -eq 0) { \$ok = \$true } }; if (-not \$ok) { npx -y codeam-cli@latest $subcommand }"
        } else {
            "npm install -g codeam-cli@latest && codeam $subcommand || npx -y codeam-cli@latest $subcommand"
        }
    }
}

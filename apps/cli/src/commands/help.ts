import pc from 'picocolors';

/**
 * Renders the same usage block the postinstall message shows, plus
 * the new `--version` / `--help` flags. Kept in sync with README.md
 * commands table — when you add a new command, update both.
 */
export function help(): void {
  const lines = [
    '',
    `  ${pc.bold(pc.magenta('codeam-cli'))}  ${pc.dim('— Claude Code remote control')}`,
    '',
    `  ${pc.bold('Usage')}`,
    `     ${pc.cyan('codeam')} ${pc.dim('[command]')}`,
    '',
    `  ${pc.bold('Commands')}`,
    `     ${pc.white('codeam')}              ${pc.dim('start Claude Code with mobile control')}`,
    `     ${pc.white('codeam pair')}         ${pc.dim('pair a new mobile device')}`,
    `     ${pc.white('codeam sessions')}     ${pc.dim('list paired devices')}`,
    `     ${pc.white('codeam status')}       ${pc.dim('show connection info')}`,
    `     ${pc.white('codeam logout')}       ${pc.dim('remove all paired sessions')}`,
    `     ${pc.white('codeam deploy')}       ${pc.dim('provision a cloud workspace (Codespaces) and pair it')}`,
    `     ${pc.white('codeam deploy ls')}    ${pc.dim('list deployed cloud workspaces')}`,
    `     ${pc.white('codeam deploy stop')}  ${pc.dim('stop a deployed workspace session')}`,
    '',
    `  ${pc.bold('Flags')}`,
    `     ${pc.white('-v, --version')}       ${pc.dim('print the CLI version')}`,
    `     ${pc.white('-h, --help')}          ${pc.dim('show this help')}`,
    '',
    `  ${pc.bold('Links')}`,
    `     ${pc.dim('Docs:')}     ${pc.green('https://www.codeagent-mobile.com')}`,
    `     ${pc.dim('Issues:')}   ${pc.green('https://github.com/edgar-durand/codeagent-mobile-clients/issues')}`,
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

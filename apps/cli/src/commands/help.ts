import pc from 'picocolors';

/**
 * Renders the same usage block the postinstall message shows, plus
 * the new `--version` / `--help` flags. Kept in sync with README.md
 * commands table — when you add a new command, update both.
 */
export function help(): void {
  const lines = [
    '',
    `  ${pc.bold(pc.magenta('codeam-cli'))}  ${pc.dim('— remote-control AI coding agents from your phone')}`,
    '',
    `  ${pc.bold('Usage')}`,
    `     ${pc.cyan('codeam')} ${pc.dim('[command]')}`,
    '',
    `  ${pc.bold('Commands')}`,
    `     ${pc.white('codeam')}                       ${pc.dim('start the active agent with mobile control')}`,
    `     ${pc.white('codeam <agent>')}               ${pc.dim('start a specific agent — e.g. claude, codex')}`,
    `     ${pc.white('codeam pair')}                  ${pc.dim('pair a new mobile device (interactive)')}`,
    `     ${pc.white('codeam pair --agent <id>')}     ${pc.dim('pair non-interactively for a specific agent')}`,
    `     ${pc.white('codeam sessions')}              ${pc.dim('list paired devices')}`,
    `     ${pc.white('codeam sessions switch')}       ${pc.dim('switch the active paired session')}`,
    `     ${pc.white('codeam sessions delete <id>')}  ${pc.dim('remove a specific paired session')}`,
    `     ${pc.white('codeam status')}                ${pc.dim('show connection info')}`,
    `     ${pc.white('codeam logout')}                ${pc.dim('remove all paired sessions')}`,
    `     ${pc.white('codeam link <agent>')}          ${pc.dim('link an agent (claude, codex) to your CodeAgent account')}`,
    `     ${pc.white('codeam deploy')}                ${pc.dim('provision a cloud workspace (Codespaces) and pair it')}`,
    `     ${pc.white('codeam deploy ls | list')}      ${pc.dim('list deployed cloud workspaces')}`,
    `     ${pc.white('codeam deploy stop | remove')}  ${pc.dim('stop a deployed workspace session')}`,
    `     ${pc.white('codeam doctor')}                ${pc.dim('run diagnostic checks (DNS, /health, binaries, …)')}`,
    `     ${pc.white('codeam completion <shell>')}    ${pc.dim('emit a bash/zsh/fish completion script')}`,
    '',
    `  ${pc.bold('Flags')}`,
    `     ${pc.white('-v, --version')}                ${pc.dim('print the CLI version')}`,
    `     ${pc.white('-h, --help')}                   ${pc.dim('show this help')}`,
    '',
    `  ${pc.bold('Links')}`,
    `     ${pc.dim('Docs:')}     ${pc.green('https://www.codeagent-mobile.com')}`,
    `     ${pc.dim('Issues:')}   ${pc.green('https://github.com/edgar-durand/codeagent-mobile-clients/issues')}`,
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

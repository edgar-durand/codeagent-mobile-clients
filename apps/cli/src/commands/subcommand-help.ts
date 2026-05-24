import pc from 'picocolors';

/**
 * Per-subcommand help text. Intercepted by the dispatcher in
 * `index.ts` so `codeam <cmd> --help` and `codeam <cmd> -h` short-
 * circuit before the command's own side effects (network calls,
 * agent spawn, etc.) run.
 *
 * Add a new entry here when you ship a new subcommand. The CI smoke
 * matrix exercises `<cmd> --help` for every key in this map, so
 * forgetting an entry surfaces as a CI failure.
 */
type HelpRenderer = () => void;

const HELPS: Record<string, HelpRenderer> = {
  pair: () =>
    print([
      `  ${pc.bold('codeam pair')}  ${pc.dim('— pair a mobile device with this CLI')}`,
      '',
      `     ${pc.cyan('codeam pair')}                  ${pc.dim('interactive pairing (prompts for the agent)')}`,
      `     ${pc.cyan('codeam pair --agent <id>')}     ${pc.dim('pair non-interactively (agent: claude | codex)')}`,
      `     ${pc.cyan('codeam pair --dry-run')}        ${pc.dim('request a pairing code, validate the response, exit')}`,
    ]),
  'pair-auto': () =>
    print([
      `  ${pc.bold('codeam pair-auto')}  ${pc.dim('— non-interactive variant of pair for scripted setups')}`,
      '',
      `     ${pc.cyan('codeam pair-auto --agent <id>')}  ${pc.dim('pair using the supplied agent id; exit on success or timeout')}`,
    ]),
  link: () =>
    print([
      `  ${pc.bold('codeam link <agent>')}  ${pc.dim('— upload a local agent token (Claude or Codex) to your vault')}`,
      '',
      `     ${pc.cyan('codeam link claude')}`,
      `     ${pc.cyan('codeam link codex')}`,
      '',
      `     ${pc.white('--api-key=<key>')}      ${pc.dim('paste an API key directly (visible in `ps -ef`)')}`,
      `     ${pc.white('--api-key-file=<path>')} ${pc.dim('read API key from a file (recommended for CI / scripts)')}`,
      `     ${pc.white('--reuse-existing')}     ${pc.dim('upload existing creds without re-launching the agent login')}`,
      `     ${pc.white('--token-file=<path>')}  ${pc.dim('manual credential blob path for unusual vendor locations')}`,
      `     ${pc.white('--dry-run')}            ${pc.dim('probe the /api/plugin/agents/<agent>/link endpoint and exit')}`,
    ]),
  sessions: () =>
    print([
      `  ${pc.bold('codeam sessions')}  ${pc.dim('— list, switch, or delete paired mobile sessions')}`,
      '',
      `     ${pc.cyan('codeam sessions')}              ${pc.dim('list all paired sessions on this machine')}`,
      `     ${pc.cyan('codeam sessions switch')}       ${pc.dim('interactively switch the active session')}`,
      `     ${pc.cyan('codeam sessions delete <id>')}  ${pc.dim('remove a specific paired session')}`,
    ]),
  deploy: () =>
    print([
      `  ${pc.bold('codeam deploy')}  ${pc.dim('— provision a cloud workspace (GitHub Codespaces) and pair it')}`,
      '',
      `     ${pc.cyan('codeam deploy')}                ${pc.dim('start a new deploy (prompts for repo + agent)')}`,
      `     ${pc.cyan('codeam deploy ls | list')}      ${pc.dim('list deployed cloud workspaces')}`,
      `     ${pc.cyan('codeam deploy stop | remove')}  ${pc.dim('pick a workspace and stop its codeam-pair session')}`,
    ]),
  status: () =>
    print([
      `  ${pc.bold('codeam status')}  ${pc.dim('— show the active session, agent, and connection info')}`,
    ]),
  logout: () =>
    print([
      `  ${pc.bold('codeam logout')}  ${pc.dim('— remove every paired session from this machine')}`,
    ]),
  doctor: () =>
    print([
      `  ${pc.bold('codeam doctor')}  ${pc.dim('— run diagnostic checks for support triage')}`,
      '',
      `     ${pc.cyan('codeam doctor')}          ${pc.dim('human-readable report')}`,
      `     ${pc.cyan('codeam doctor --json')}   ${pc.dim('machine-parseable report (single JSON document on stdout)')}`,
      '',
      `     ${pc.dim('Output never includes tokens or credentials. Paste the diagnostic id')}`,
      `     ${pc.dim('into a bug report so support can grep the server-side logs.')}`,
    ]),
  completion: () =>
    print([
      `  ${pc.bold('codeam completion <shell>')}  ${pc.dim('— emit a shell-completion script for sourcing')}`,
      '',
      `     ${pc.cyan('codeam completion bash')}  ${pc.dim('print a bash completion function')}`,
      `     ${pc.cyan('codeam completion zsh')}   ${pc.dim('print a zsh completion function')}`,
      `     ${pc.cyan('codeam completion fish')}  ${pc.dim('print a fish completion file')}`,
      '',
      `     ${pc.dim('Examples:')}`,
      `     ${pc.dim('  bash:  codeam completion bash >> ~/.bashrc')}`,
      `     ${pc.dim('  zsh:   codeam completion zsh >> ~/.zshrc')}`,
      `     ${pc.dim('  fish:  codeam completion fish > ~/.config/fish/completions/codeam.fish')}`,
    ]),
};

function print(lines: string[]): void {
  process.stdout.write(['', ...lines, ''].join('\n') + '\n');
}

export function isHelpFlag(arg: string | undefined): boolean {
  return arg === '--help' || arg === '-h';
}

/**
 * Returns true when `args` requests help for `cmd`. The dispatcher
 * uses this BEFORE invoking the command's handler so the help bypass
 * never touches network, filesystem, or PTY spawns.
 *
 * Only `args[0]` is inspected — `codeam pair --agent claude --help`
 * is treated as "pair with claude", not "show pair help", matching
 * common CLI ergonomics.
 */
export function tryShowSubcommandHelp(cmd: string, args: string[]): boolean {
  if (!isHelpFlag(args[0])) return false;
  const renderer = HELPS[cmd];
  if (!renderer) return false;
  renderer();
  return true;
}

/** Visible for tests. */
export const _subcommandHelpKeys = Object.keys(HELPS);

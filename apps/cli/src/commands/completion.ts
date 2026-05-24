/**
 * `codeam completion <shell>` — emit a shell-completion script.
 *
 * Hand-rolled instead of using a library because:
 *   1. The three supported shells (bash / zsh / fish) each want a
 *      slightly different shape, and the auto-generators that
 *      handle all three (omelette, tabtab) drag in dependencies
 *      we'd otherwise avoid.
 *   2. The completion surface is small + stable — the top-level
 *      commands list + the AGENT_REGISTRY agent ids.
 *
 * Users wire it up by sourcing the output:
 *   bash: `codeam completion bash >> ~/.bashrc`
 *   zsh:  `codeam completion zsh >> ~/.zshrc`
 *   fish: `codeam completion fish > ~/.config/fish/completions/codeam.fish`
 */

import { AGENT_REGISTRY, type AgentMetadata } from '@codeagent/shared';

const COMMANDS = [
  'pair',
  'pair-auto',
  'sessions',
  'status',
  'logout',
  'link',
  'doctor',
  'deploy',
  'completion',
  'version',
  'help',
] as const;

function enabledAgentIds(): string[] {
  return Object.values(AGENT_REGISTRY)
    .filter((m: AgentMetadata) => m.enabled)
    .map((m: AgentMetadata) => m.id);
}

function bashScript(): string {
  const commands = [...COMMANDS, ...enabledAgentIds()].join(' ');
  return [
    '# codeam bash completion. Source from ~/.bashrc:',
    '#   eval "$(codeam completion bash)"',
    '_codeam_completions() {',
    '  local cur prev words cword',
    '  COMPREPLY=()',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    `  local cmds="${commands}"`,
    '  if [ "$COMP_CWORD" -eq 1 ]; then',
    '    COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )',
    '    return 0',
    '  fi',
    '  # Two-arg completion for `codeam link <agent>` etc.',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    `  case "$prev" in link) COMPREPLY=( $(compgen -W "${enabledAgentIds().join(' ')}" -- "$cur") ) ;;`,
    '    deploy) COMPREPLY=( $(compgen -W "ls list stop remove" -- "$cur") ) ;;',
    '    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ) ;;',
    '  esac',
    '  return 0',
    '}',
    'complete -F _codeam_completions codeam',
    '',
  ].join('\n');
}

function zshScript(): string {
  const commands = [...COMMANDS, ...enabledAgentIds()].join(' ');
  return [
    '# codeam zsh completion. Source from ~/.zshrc:',
    '#   eval "$(codeam completion zsh)"',
    '_codeam() {',
    '  local context state line',
    '  _arguments -C \\',
    '    "1: :->cmd" \\',
    '    "*::arg:->args"',
    '  case "$state" in',
    `    cmd) _values "codeam command" ${commands.split(' ').map((c) => `'${c}'`).join(' ')} ;;`,
    '    args)',
    '      case "$line[1]" in',
    `        link) _values "agent" ${enabledAgentIds().map((a) => `'${a}'`).join(' ')} ;;`,
    '        deploy) _values "subcommand" "ls" "list" "stop" "remove" ;;',
    '        completion) _values "shell" "bash" "zsh" "fish" ;;',
    '      esac ;;',
    '  esac',
    '}',
    'compdef _codeam codeam',
    '',
  ].join('\n');
}

function fishScript(): string {
  const lines: string[] = [
    '# codeam fish completion. Save to:',
    '#   ~/.config/fish/completions/codeam.fish',
  ];
  for (const cmd of COMMANDS) {
    lines.push(
      `complete -c codeam -n "__fish_use_subcommand" -a "${cmd}" -d "codeam ${cmd}"`,
    );
  }
  for (const agent of enabledAgentIds()) {
    lines.push(
      `complete -c codeam -n "__fish_use_subcommand" -a "${agent}" -d "start ${agent}"`,
    );
    lines.push(
      `complete -c codeam -n "__fish_seen_subcommand_from link" -a "${agent}" -d "link ${agent}"`,
    );
  }
  for (const sub of ['ls', 'list', 'stop', 'remove']) {
    lines.push(
      `complete -c codeam -n "__fish_seen_subcommand_from deploy" -a "${sub}"`,
    );
  }
  for (const shell of ['bash', 'zsh', 'fish']) {
    lines.push(
      `complete -c codeam -n "__fish_seen_subcommand_from completion" -a "${shell}"`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export async function completion(args: string[]): Promise<void> {
  // First positional arg is the shell name (cac stripped the
  // 'completion' command itself; we receive the rest).
  const shell = args.find((a) => !a.startsWith('-'));
  if (!shell || !['bash', 'zsh', 'fish'].includes(shell)) {
    process.stderr.write(
      '\n  Usage: codeam completion <bash|zsh|fish>\n' +
        '\n  Example (bash):\n' +
        '    codeam completion bash >> ~/.bashrc && source ~/.bashrc\n' +
        '\n  Example (zsh):\n' +
        '    codeam completion zsh >> ~/.zshrc && source ~/.zshrc\n' +
        '\n  Example (fish):\n' +
        '    codeam completion fish > ~/.config/fish/completions/codeam.fish\n\n',
    );
    process.exit(2);
  }
  const script =
    shell === 'bash' ? bashScript() : shell === 'zsh' ? zshScript() : fishScript();
  // Completion scripts MUST go to stdout — users redirect to a
  // shell config file via `>` or `eval "$(...)"`.
  process.stdout.write(script);
}

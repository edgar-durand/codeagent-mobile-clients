const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  violet: '\x1b[35m',
  white: '\x1b[97m',
};

const lines = [
  '',
  `  ${c.violet}${c.bold}codeam-cli${c.reset}  ${c.dim}— Claude Code remote control${c.reset}`,
  '',
  `  ${c.dim}1.${c.reset} Pair your phone:`,
  `     ${c.cyan}codeam pair${c.reset}`,
  '',
  `  ${c.dim}2.${c.reset} Launch Claude Code with mobile control:`,
  `     ${c.cyan}codeam${c.reset}`,
  '',
  `  ${c.dim}Other commands:${c.reset}`,
  `     ${c.white}codeam sessions${c.reset}   ${c.dim}list paired devices${c.reset}`,
  `     ${c.white}codeam status${c.reset}     ${c.dim}show connection info${c.reset}`,
  `     ${c.white}codeam logout${c.reset}     ${c.dim}remove all sessions${c.reset}`,
  '',
  `  ${c.dim}Requires Claude Code:${c.reset} ${c.green}npm install -g @anthropic-ai/claude-code${c.reset}`,
  `  ${c.dim}Mobile app:${c.reset}           ${c.green}https://www.codeagent-mobile.com${c.reset}`,
  '',
];

process.stdout.write(lines.join('\n') + '\n');

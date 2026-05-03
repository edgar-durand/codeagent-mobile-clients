import { start } from './commands/start';
import { pair } from './commands/pair';
import { sessions } from './commands/sessions';
import { status } from './commands/status';
import { logout } from './commands/logout';
import { deploy } from './commands/deploy';
import { deployList, deployStop } from './commands/deploy-manage';

const [,, command, ...args] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case 'pair':     return pair();
    case 'sessions': return sessions(args);
    case 'status':   return status();
    case 'logout':   return logout();
    case 'deploy':
      // `codeam deploy`             → start a new deploy
      // `codeam deploy ls|list`     → list deployed workspaces
      // `codeam deploy stop|remove` → pick a workspace and stop its codeam-pair session
      if (args[0] === 'ls' || args[0] === 'list') return deployList();
      if (args[0] === 'stop' || args[0] === 'remove') return deployStop();
      return deploy();
    default:         return start();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${msg}\n`);
  process.exit(1);
});

import { start } from './commands/start';
import { pair } from './commands/pair';
import { pairAuto } from './commands/pair-auto';
import { sessions } from './commands/sessions';
import { status } from './commands/status';
import { logout } from './commands/logout';
import { deploy } from './commands/deploy';
import { deployList, deployStop } from './commands/deploy-manage';
import { version } from './commands/version';
import { help } from './commands/help';
import { checkForUpdates } from './lib/updateNotifier';

const [,, command, ...args] = process.argv;

async function main(): Promise<void> {
  // Fire-and-forget: shows a one-liner if a newer version is in the
  // npm registry cache (refreshed in the background, never blocks).
  // Skipped automatically for `--version` / `--help` so those calls
  // stay fast and predictable for tooling that scrapes them.
  const isMetaCommand =
    command === '--version' || command === '-v' || command === 'version' ||
    command === '--help' || command === '-h' || command === 'help';
  if (!isMetaCommand) checkForUpdates();

  switch (command) {
    case '--version':
    case '-v':
    case 'version':  return version();
    case '--help':
    case '-h':
    case 'help':     return help();
    case 'pair':     return pair(args);
    case 'pair-auto': return pairAuto(args);
    case 'sessions': return sessions(args);
    case 'status':   return status();
    case 'logout':   return logout();
    case 'deploy':
      // `codeam deploy`             → start a new deploy
      // `codeam deploy ls|list`     → list deployed workspaces
      // `codeam deploy stop|remove` → pick a workspace and stop its codeam-pair session
      if (args[0] === 'ls' || args[0] === 'list') return deployList();
      if (args[0] === 'stop' || args[0] === 'remove') return deployStop();
      return deploy(args);
    default:         return start();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${msg}\n`);
  process.exit(1);
});

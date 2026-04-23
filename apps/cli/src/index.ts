import { start } from './commands/start';
import { pair } from './commands/pair';
import { sessions } from './commands/sessions';
import { status } from './commands/status';
import { logout } from './commands/logout';

const [,, command, ...args] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case 'pair':     return pair();
    case 'sessions': return sessions(args);
    case 'status':   return status();
    case 'logout':   return logout();
    default:         return start();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${msg}\n`);
  process.exit(1);
});

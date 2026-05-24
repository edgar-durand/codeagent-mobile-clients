import { start } from './commands/start';
import { pair } from './commands/pair';
import { pairAuto } from './commands/pair-auto';
import { sessions } from './commands/sessions';
import { status } from './commands/status';
import { logout } from './commands/logout';
import { deploy } from './commands/deploy';
import { deployList, deployStop } from './commands/deploy-manage';
import { link } from './commands/link';
import { doctor } from './commands/doctor';
import { version } from './commands/version';
import { help } from './commands/help';
import { tryShowSubcommandHelp } from './commands/subcommand-help';
import { checkForUpdates } from './lib/updateNotifier';
import { isKnownAgentId } from '@codeagent/shared';
import {
  initTelemetry,
  maybePrintFirstRunBanner,
  capture,
  shutdownTelemetry,
} from './services/telemetry.service';
import { EXIT_FAILURE, EXIT_USAGE } from './exit-codes';

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

  // Telemetry boot — gated by opt-out env / no-key-baked. The
  // first-run banner prints once per machine + writes a marker so
  // returning users don't see it every invocation.
  if (initTelemetry()) {
    maybePrintFirstRunBanner();
    capture('cli_boot', { command: command ?? '(default)' });
  }

  // Per-subcommand --help intercept. Runs BEFORE dispatch so the help
  // bypass never triggers network calls, agent spawns, or interactive
  // prompts. The CI smoke matrix relies on this for every subcommand.
  if (typeof command === 'string' && tryShowSubcommandHelp(command, args)) {
    return;
  }

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
    case 'link':     return link(args);
    case 'doctor':   return doctor(args);
    case 'deploy':
      // `codeam deploy`             → start a new deploy
      // `codeam deploy ls|list`     → list deployed workspaces
      // `codeam deploy stop|remove` → pick a workspace and stop its codeam-pair session
      if (args[0] === 'ls' || args[0] === 'list') return deployList();
      if (args[0] === 'stop' || args[0] === 'remove') return deployStop();
      return deploy(args);
    default:
      // `codeam <agent>` (e.g. `codeam codex`) restores the most-recently-
      // paired session for THAT agent — robust against another terminal
      // having just paired a different agent and promoted its session to
      // the globally-active pointer.
      if (typeof command === 'string' && isKnownAgentId(command)) {
        return start(command);
      }
      // Unknown subcommand (audit CLI finding 3 / quick win #67):
      // `codeam fooo` previously silently fell through to start()
      // which produced "no paired session" or worse — booted an
      // agent with the user's intent ignored. Now we exit 2 with
      // a typo-correction hint so the user sees the mistake.
      if (typeof command === 'string' && command.length > 0) {
        process.stderr.write(
          `\n  Unknown command: ${command}\n` +
            `  Run 'codeam help' to see the supported commands.\n\n`,
        );
        await shutdownTelemetry();
        process.exit(EXIT_USAGE);
      }
      return start();
  }
}

main()
  .then(() => shutdownTelemetry())
  .catch(async (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${msg}`);
    // CODEAM_DEBUG=1 hint so users with a confusing failure know
    // the breadcrumb path (audit CLI finding 6 / quick win #67).
    // Only surfaced when not already in debug mode — avoids
    // suggesting the same flag the user already set.
    if (process.env.CODEAM_DEBUG !== '1') {
      console.error(`  ${'(set CODEAM_DEBUG=1 for a full stack trace + ~/.codeam/debug-<pid>.log)'}\n`);
    } else {
      console.error('');
    }
    // Best-effort flush before exit so the failure event we just
    // captured upstream isn't dropped on the floor.
    try { await shutdownTelemetry(); } catch { /* swallow */ }
    process.exit(EXIT_FAILURE);
  });

import { start } from './commands/start';
import { pair } from './commands/pair';
import { pairAuto } from './commands/pair-auto';
import { sessions } from './commands/sessions';
import { status } from './commands/status';
import { logout } from './commands/logout';
import { deploy } from './commands/deploy';
import { deployList, deployStop } from './commands/deploy-manage';
import { host } from './commands/host';
import { hostAgent } from './commands/host-agent';
import { link } from './commands/link';
import { invite } from './commands/invite';
import { doctor } from './commands/doctor';
import { completion } from './commands/completion';
import { mcpRun } from './integrations/mcp-run';
import { mcpWarm } from './integrations/mcp-warm';
import { version } from './commands/version';
import { help } from './commands/help';
import { tryShowSubcommandHelp } from './commands/subcommand-help';
import { checkForUpdates, autoUpgradeBeforeCriticalCommand } from './lib/updateNotifier';
import { isKnownAgentId } from '@codeam/shared';
import {
  initTelemetry,
  maybePrintFirstRunBanner,
  capture,
  shutdownTelemetry,
} from './services/telemetry.service';
import { EXIT_FAILURE, EXIT_USAGE } from './exit-codes';
import { loadCodespaceEnv } from './config';
import * as os from 'node:os';

// Guarantee $HOME is set before ANY command runs. The self-hosted
// host-agent is launched detached (PPID 1, no login shell) by the
// background fallback when systemd is absent, so its process env — and
// every child it spawns (pair-auto → bd → dolt, git, the agent) — inherits
// NO $HOME. `bd init` / `dolt` then abort with "cannot determine home
// directory: $HOME is not defined" (verified live on a self-hosted Docker
// box: HOME unset on the host-agent + pair-auto pids), which failed Beads
// provisioning on every such box. `os.homedir()` resolves the real home
// from the passwd database even when $HOME is unset, so this is a safe,
// universal backfill that fixes bd/dolt and anything else keyed off HOME.
if (!process.env.HOME) {
  try {
    const home = os.homedir();
    if (home) process.env.HOME = home;
  } catch {
    /* os.homedir() can throw if the uid has no passwd entry — leave unset */
  }
}

// Load `~/.codeam/codespace-env.json` into process.env BEFORE any command
// runs. The codespace serving daemon is spawned via `setsid` (no shell rc),
// so the backend bootstrap's exported vars (PREVIEW_TUNNEL_TOKEN/HOSTNAME,
// HEADROOM_*) never reach the daemon's env. Reading the file here restores
// them so the named preview tunnel + the Headroom savings reporter (gated on
// HEADROOM_ENABLED, checked downstream) both work on the daemon. No-op on
// local / self-hosted where the file is absent; an explicit env var always
// wins over the file.
loadCodespaceEnv();

const [, , command, ...args] = process.argv;

/**
 * Top-level argv dispatch.
 *
 * #68 was originally scoped as a `cac` (or `commander`) migration
 * per audit CLI finding 5. After implementing, the two real wins
 * the audit cared about — "Did you mean…" typo suggestions and
 * shell-completion scaffolding — turned out cheaper to ship
 * hand-rolled than to fan through a parser library. `cac` would
 * have required either (a) routing every per-command flag through
 * its `.option()` declarations (a cross-cutting refactor of every
 * command module) or (b) staying a thin dispatcher wrapper around
 * the existing switch — adding a dep with no real benefit. We
 * landed (c): a typed dispatch table + a Levenshtein suggester +
 * a separate `completion` command that emits hand-rolled bash /
 * zsh / fish scripts.
 *
 * Top-level contracts:
 *   - per-subcommand --help intercept (subcommand-help.ts) — runs
 *     BEFORE any network call / agent spawn so help is fast +
 *     side-effect-free.
 *   - `codeam <agent>` shortcut (codeam claude / codex / aider) →
 *     restore the most-recently-paired session for THAT agent.
 *   - `codeam` with no args → default start() with the global
 *     active session.
 *   - Unknown command → exit 2 + "Did you mean …" suggestion.
 *   - `codeam completion <shell>` → emit shell-completion script.
 */
async function main(): Promise<void> {
  // Telemetry boot + update notifier — gated by isMetaCommand below
  // so `--version` / `--help` stay fast for tooling that scrapes
  // them.
  const isMetaCommand =
    command === '--version' || command === '-v' || command === 'version' ||
    command === '--help' || command === '-h' || command === 'help';
  if (!isMetaCommand) {
    // `link` / `pair` capture credentials and MUST NOT run on a stale binary —
    // pre-v2.39.80 CLIs hard-fail credential capture under PoP enforcement. So
    // for these two we upgrade SYNCHRONOUSLY on this run (and re-exec) before
    // dispatching. Everything else uses the lazy fire-and-forget notifier.
    if (command === 'link' || command === 'pair') {
      await autoUpgradeBeforeCriticalCommand();
    } else {
      checkForUpdates();
    }
  }

  if (initTelemetry()) {
    maybePrintFirstRunBanner();
    capture('cli_boot', { command: command ?? '(default)' });
  }

  // Per-subcommand --help intercept. cac has a help generator but
  // we keep the existing renderer because (a) it's hand-tuned for
  // colour + dim-prose styling we like, (b) the smoke matrix is
  // hard-wired to its output. Run BEFORE cac.parse() so the
  // network-free help path stays in place.
  if (typeof command === 'string' && tryShowSubcommandHelp(command, args)) {
    return;
  }

  // Known top-level commands. The dispatch table below sits BEFORE
  // cac so the unknown-command UX (typo suggestion + exit 2) can
  // run without cac's "Unused args" parser-strictness getting in
  // the way. Per-command flag parsing intentionally stays inside
  // each command's own module — the migration to cac-managed flags
  // is a follow-up that touches every command one at a time.
  const commands: Record<string, () => Promise<void> | void> = {
    'pair': () => pair(args),
    'pair-auto': () => pairAuto(args),
    'host-agent': () => hostAgent(args),
    'host': () => host(args),
    'sessions': () => sessions(args),
    'status': () => status(),
    'invite': () => invite(),
    'logout': () => logout(),
    'link': () => link(args),
    'doctor': () => doctor(args),
    'completion': () => completion(args),
    'version': () => version(),
    'help': () => help(),
    '--version': () => version(),
    '-v': () => version(),
    '--help': () => help(),
    '-h': () => help(),
  };

  if (typeof command === 'string' && commands[command]) {
    await commands[command]();
    return;
  }

  // `codeam mcp-run <id>` — the token-refreshing stdio shim for integration
  // MCP servers. HIDDEN: it's launched BY the agent's own MCP client config
  // (never typed by a human), so it's dispatched here — outside the
  // `commands` table — specifically so it never appears in `codeam help`
  // or in the "Did you mean …" typo-suggestion candidates (those are both
  // derived from `Object.keys(commands)`, see below).
  if (command === 'mcp-run') {
    return mcpRun(args);
  }

  // `codeam mcp-warm [id…]` — pre-fetch the integration MCP server packages so
  // the agent never pays for the download inside its own `session/new` budget.
  // Hidden for the same reason as `mcp-run`: it is run by the IMAGE BUILD (and
  // by provisioning), not typed by a human.
  if (command === 'mcp-warm') {
    return mcpWarm(args);
  }

  // `deploy` has a small sub-router (deploy / deploy ls / deploy
  // stop). Inspect args[0] and dispatch.
  if (command === 'deploy') {
    if (args[0] === 'ls' || args[0] === 'list') return deployList();
    if (args[0] === 'stop' || args[0] === 'remove') return deployStop();
    return deploy(args);
  }

  // `codeam <agent>` shortcut — restore the most-recently-paired
  // session for THAT agent.
  if (typeof command === 'string' && isKnownAgentId(command)) {
    return start(command);
  }

  // Unknown command path. Pre-#68 this silently fell through to
  // start(); now we emit a "Did you mean ..." suggestion + exit 2.
  if (typeof command === 'string' && command.length > 0 && !command.startsWith('-')) {
    process.stderr.write(`\n  Unknown command: ${command}\n`);
    const suggestion = suggestCommand(
      command,
      [...Object.keys(commands), 'deploy'],
    );
    if (suggestion) {
      process.stderr.write(`  Did you mean '${suggestion}'?\n`);
    }
    process.stderr.write(`  Run 'codeam help' to see the supported commands.\n\n`);
    await shutdownTelemetry();
    process.exit(EXIT_USAGE);
  }

  // Bare `codeam` (no positional args) → default start().
  return start();
}

/**
 * Tiny Levenshtein-distance suggester for the unknown-command path.
 * Hand-rolled because cac's built-in is tied to its parse() error
 * flow which we deliberately bypass in our pre-dispatch table.
 * Returns the closest registered command when within edit-distance
 * 2 (typical typo radius); null otherwise.
 */
function suggestCommand(input: string, candidates: string[]): string | null {
  const dist = (a: string, b: string): number => {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const prev = new Array<number>(n + 1).fill(0).map((_, i) => i);
    const curr = new Array<number>(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= n; j++) prev[j] = curr[j];
    }
    return prev[n];
  };
  let best: { name: string; d: number } | null = null;
  for (const cand of candidates) {
    if (cand.startsWith('-')) continue;
    const d = dist(input.toLowerCase(), cand.toLowerCase());
    if (d <= 2 && (best === null || d < best.d)) best = { name: cand, d };
  }
  return best ? best.name : null;
}

main()
  .then(() => shutdownTelemetry())
  .catch(async (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${msg}`);
    // CODEAM_DEBUG=1 hint so users with a confusing failure know
    // the breadcrumb path (audit CLI finding 6 / quick win #67).
    if (process.env.CODEAM_DEBUG !== '1') {
      console.error(`  ${'(set CODEAM_DEBUG=1 for a full stack trace + ~/.codeam/debug-<pid>.log)'}\n`);
    } else {
      console.error('');
    }
    try { await shutdownTelemetry(); } catch { /* swallow */ }
    process.exit(EXIT_FAILURE);
  });

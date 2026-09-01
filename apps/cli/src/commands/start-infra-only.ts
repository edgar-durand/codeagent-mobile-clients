import { AGENT_REGISTRY, type AgentId } from '@codeam/shared';
import { CommandRelayService, type RemoteCommand } from '../services/command-relay.service';
import { FileWatcherService } from '../services/file-watcher.service';
import { ChunkEmitter } from '../services/output/chunk-emitter';
import { registerTerminalHandlers, closeAllTerminals } from '../services/terminal-ops.service';
import { handlers as commandHandlers, cleanupAttachmentTempFiles, makePreviewReaffirm } from './start/handlers';
import { buildKeepAlive } from './start/keep-alive';
import type { HandlerContext } from './start/handlers';
import { getActiveSession } from '../config';
import { parsePayload, startCommandSchema } from '../lib/payload';
import { provisionBeadsForStart, beadsActionFromPayload } from '../beads/wiring';
import { handleBeadsActionCommand, type StartedBeads } from '../beads';
import { log } from '../services/logger';
import { installRelayCrashGuards } from '../lib/process-guards';

/**
 * Infra-only run loop: the in-codespace counterpart to `start()`
 * for deploys that intentionally skip the agent launch
 * (`CODEAM_SKIP_AGENT_LAUNCH=true`, set by the api's
 * `runInfraBootstrap`).
 *
 * Same goals as `start()` minus the agent itself:
 *
 *   - Heartbeat the api every 20 s so the per-user SSE bus
 *     emits `paired_session_status { online: true }` — without
 *     this the dashboard's `SessionPage` gets stuck at "Loading
 *     session…" and the SessionsList card shows OFFLINE.
 *
 *   - Watch the workspace via `FileWatcherService` so the
 *     dashboard's Files panel + per-file change pings work
 *     (these don't depend on an agent — the watcher just emits
 *     `/api/files/changed` for each modified file).
 *
 *   - Register IDE terminal handlers so the dashboard's "Open
 *     terminal" works against the codespace shell, agent or no.
 *
 *   - Dispatch the IDE-safe subset of remote commands
 *     (`list_files`, `read_file`, `write_file`, `search_files`,
 *     `terminal_*`, `git_*`, `apply_file_review`,
 *     `request_link_credentials`, `set_keep_alive`). The
 *     agent-touching commands (`start_task`, `provide_input`,
 *     `change_model`, etc.) are silently dropped — once the user
 *     installs an agent via the dashboard's NoAgentHero, the
 *     install endpoint SSHes back in and runs `codeam` from a
 *     fresh login shell that doesn't inherit
 *     `CODEAM_SKIP_AGENT_LAUNCH`, so `start()` takes over with
 *     the full agent loop.
 *
 *   - Report an EMPTY agents list to `/api/plugin/agents` so the
 *     dashboard detects `sessionVariant === 'no-agent'` and
 *     renders the NoAgentHero install CTA instead of a chat
 *     surface for an absent agent.
 *
 * Decoupled from `start()` on purpose: `start()` is the
 * with-agent path that works perfectly in prod — any drift
 * there is a real regression. Keeping the no-agent flow in a
 * separate file makes the dependency surface explicit and the
 * with-agent code path unchanged.
 */

/**
 * Remote command types the no-agent CLI knows how to handle.
 * Everything else is dropped silently (logged at trace) — the
 * agent-specific commands (`start_task`, `provide_input`,
 * `select_option`, `change_model`, etc.) have nothing to forward
 * to in this mode, and answering them with an error would
 * surface as a noisy failure on the dashboard for a flow the
 * user never initiated.
 */
const INFRA_ONLY_COMMAND_TYPES: ReadonlySet<string> = new Set([
  // File ops (drive the dashboard's Files panel + open-file).
  'read_file',
  'write_file',
  'list_files',
  'search_files',
  // IDE terminal — the user opens a shell inside the codespace
  // from the dashboard. Independent of any agent.
  'terminal_open',
  'terminal_write',
  'terminal_resize',
  'terminal_close',
  // Git surface — repo browsing / commit / push from the
  // dashboard. Calls plain `git`, no agent involved.
  'git_status',
  'git_diff',
  'git_diff_staged',
  'git_log',
  'git_commit',
  'git_push',
  'git_pull',
  'git_resolve',
  // Review apply path (dashboard's per-file review surface).
  'apply_file_review',
  // CLI-side handoff for `codeam link <agent>` (claims tokens
  // for the user's LinkedAgents from inside the codespace).
  'request_link_credentials',
  // Lets the dashboard toggle the codespace idle-timeout
  // (defaults to 240 min inside a codespace).
  'set_keep_alive',
]);

export async function startInfraOnly(agentId: AgentId): Promise<void> {
  // Daemon crash guard — same rationale as start(): a stray rejection must
  // not kill the infra-only relay (dashboard Files/terminal would go dead).
  installRelayCrashGuards();
  const session = getActiveSession();
  if (!session?.pluginId) {
    throw new Error('startInfraOnly: no active session found in config');
  }
  const pluginId = session.pluginId;
  const cwd = process.cwd();

  const agentMeta = AGENT_REGISTRY[agentId];
  if (!agentMeta) {
    throw new Error(`startInfraOnly: unknown agent id "${agentId}"`);
  }

  // Keep-alive: same default-on inside a codespace contract as
  // `start()` — re-asserts `idle_timeout_minutes=240` every 30 min
  // so a GitHub-side reset can self-heal. No-op outside a codespace.
  const keepAliveCtx = {
    inCodespace: process.env.CODESPACES === 'true',
    codespaceName: process.env.CODESPACE_NAME,
  };
  const { apply: setKeepAlive } = buildKeepAlive(keepAliveCtx);
  if (keepAliveCtx.inCodespace) {
    setKeepAlive(true);
  }

  // File watcher — drives the dashboard's Files panel + per-file
  // change pings. Same wiring as `start()`. The watcher's own
  // failure modes are logged inside; never blocks the loop.
  const fileWatcher = session.pluginAuthToken
    ? new FileWatcherService({
        workingDir: cwd,
        sessionId: session.id,
        pluginId,
        pluginAuthToken: session.pluginAuthToken,
      })
    : null;

  // Beads — composition-root concern (SRP decision D10). `startInfraOnly` is
  // the codespace counterpart of `start()` (the api's infra bootstrap runs
  // `pair-auto`→here when the agent launch is skipped), so beads must be
  // provisioned on this path too — otherwise codespaces that never install an
  // agent would miss it. Fired (not awaited) + strictly non-fatal; the live
  // handle routes relayed `beads_action` commands into the orchestrator.
  let beads: StartedBeads | null = null;
  void provisionBeadsForStart({
    sessionId: session.id,
    pluginId,
    pluginAuthToken: session.pluginAuthToken ?? undefined,
    cwd,
  }).then((started) => {
    beads = started;
  });

  // The relay is built first so the handler dispatcher (below)
  // can close over it. `agentsOverride: []` is what tells the
  // dashboard we're in no-agent mode.
  let relayRef: CommandRelayService | null = null;

  const ctx: HandlerContext = {
    // Agent-touching fields are not used by any of the commands
    // we dispatch in this mode. Casting through `unknown` keeps
    // TypeScript happy without forcing a HandlerContext refactor
    // — the field-touching commands are filtered out by
    // INFRA_ONLY_COMMAND_TYPES before the handler is even called.
    agent: null as unknown as HandlerContext['agent'],
    outputSvc: null as unknown as HandlerContext['outputSvc'],
    historySvc: null as unknown as HandlerContext['historySvc'],
    runtime: null as unknown as HandlerContext['runtime'],
    relay: null as unknown as HandlerContext['relay'],
    setKeepAlive,
    keepAliveCtx,
    pluginId,
    sessionId: session.id,
    // No-agent mode — there's no running agent to report. Headroom/agent
    // commands are filtered out by INFRA_ONLY_COMMAND_TYPES before dispatch.
    agentId: '',
    pluginAuthToken: session.pluginAuthToken ?? undefined,
  };

  const relay = new CommandRelayService(
    pluginId,
    async (cmd: RemoteCommand) => {
      // Beads actions carry a `{action, args}` shape that doesn't fit
      // `startCommandSchema`; replay them as native bd commands via the
      // composition-root-owned handle. Strictly non-fatal.
      if (cmd.type === 'beads_action') {
        if (!beads) {
          log.trace('infra-only', 'beads_action received but beads not running — dropping');
          return;
        }
        const action = beadsActionFromPayload(cmd.payload);
        if (!action) {
          log.warn('infra-only', 'malformed beads_action payload — dropping');
          return;
        }
        try {
          await handleBeadsActionCommand(action, beads);
        } catch (err) {
          log.warn('infra-only', 'handleBeadsActionCommand failed (non-fatal)', err as Error);
        }
        return;
      }
      if (!INFRA_ONLY_COMMAND_TYPES.has(cmd.type)) {
        log.trace('infra-only', `dropping agent-only command type=${cmd.type}`);
        return;
      }
      const handler = commandHandlers[cmd.type];
      if (!handler) {
        log.trace('infra-only', `no handler registered for type=${cmd.type}`);
        return;
      }
      const parsed = parsePayload(startCommandSchema, cmd.payload);
      if (!parsed) {
        log.trace('infra-only', `malformed payload for type=${cmd.type}`);
        return;
      }
      try {
        await handler(ctx, cmd, parsed);
      } catch (err) {
        log.warn('infra-only', `handler ${cmd.type} threw`, err as Error);
      }
    },
    agentMeta,
    [], // empty agents list → dashboard renders NoAgentHero
    undefined,
    // El camino infra-only NO tiene agente, pero SÍ puede tener preview (es la
    // ruta del panel de archivos), así que su snapshot caduca igual.
    makePreviewReaffirm({
      sessionId: session.id,
      pluginId,
      pluginAuthToken: session.pluginAuthToken ?? undefined,
    }),
  );
  ctx.relay = relay;
  relayRef = relay;

  // Wire IDE terminal data/exit events through the same chunk
  // channel `start()` uses. In `start()` the `OutputService`
  // wraps this — but `OutputService` depends on `runtime` (the
  // agent strategy) for chat parsing, which we deliberately
  // don't have here. The underlying transport (`ChunkEmitter`)
  // is runtime-free, so we use it directly. The chunk shapes
  // are identical to what `OutputService.sendTerminal{Chunk,Exit}`
  // emits, so the api / dashboard can't tell which path the
  // chunk came through.
  const terminalEmitter = new ChunkEmitter({
    sessionId: session.id,
    pluginId,
    pluginAuthToken: session.pluginAuthToken,
  });
  registerTerminalHandlers({
    onData: ({ sessionId: termSessionId, data }) => {
      void terminalEmitter.send({
        type: 'terminal_data',
        terminalSessionId: termSessionId,
        data,
        done: false,
      });
    },
    onExit: ({ sessionId: termSessionId, exitCode }) => {
      void terminalEmitter.send({
        type: 'terminal_exit',
        terminalSessionId: termSessionId,
        exitCode,
        done: true,
      });
    },
  });

  relay.start();
  if (fileWatcher) {
    fileWatcher.start().catch(() => {
      /* logged inside */
    });
  }

  const sigHandler = (): void => {
    try {
      relayRef?.stop();
    } catch {
      /* best-effort */
    }
    void fileWatcher?.stop();
    void beads?.watcher.stop();
    closeAllTerminals();
    cleanupAttachmentTempFiles();
    process.exit(0);
  };
  process.once('SIGINT', sigHandler);
  process.once('SIGTERM', sigHandler);
  process.once('SIGHUP', sigHandler);

  // Block forever — the relay's 20 s heartbeat timer keeps the
  // event loop alive; SIGINT/SIGTERM above is the only exit.
  await new Promise<void>(() => {
    /* never resolves */
  });
}

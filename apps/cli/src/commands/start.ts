import pc from 'picocolors';
import { AGENT_REGISTRY, type AgentId } from '@codeagent/shared';
import { getActiveSession, getActiveSessionForAgent, ensurePluginId } from '../config';
import { showIntro, showInfo } from '../ui/banner';
import { CommandRelayService } from '../services/command-relay.service';
import { AgentService } from '../services/agent.service';
import { createRuntimeStrategy } from '../agents/registry';
import { OutputService } from '../services/output.service';
import { HistoryService } from '../services/history.service';
import { fetchQuotaUsage } from './start/quota-fetcher';
import { buildKeepAlive } from './start/keep-alive';
import { dispatchCommand, type HandlerContext } from './start/handlers';
import { registerTerminalHandlers } from '../services/terminal-ops.service';

/**
 * Wires the long-running services (PTY ↔ output relay ↔ command
 * dispatch ↔ history) into a paired-session run-loop. Every piece
 * of behaviour beyond wiring lives in a sibling module under
 * `start/` so this file stays a readable orchestrator.
 */
export async function start(requestedAgent?: AgentId): Promise<void> {
  showIntro();

  // When the user runs `codeam <agent>`, restore the most-recently-paired
  // session for THAT agent — not whatever session was last promoted to the
  // global activeSessionId pointer (which is shared across terminals and
  // gets clobbered every time any terminal pairs a new session).
  const session = requestedAgent
    ? getActiveSessionForAgent(requestedAgent)
    : getActiveSession();
  if (!session) {
    if (requestedAgent) {
      const displayName = AGENT_REGISTRY[requestedAgent]?.displayName ?? requestedAgent;
      console.log(`  ${pc.dim(`No paired ${displayName} session found.`)}`);
      console.log(
        `  ${pc.dim(`Run ${pc.white('codeam pair')} from a ${displayName} setup to connect your mobile app.`)}\n`,
      );
    } else {
      console.log(`  ${pc.dim('No paired session found.')}`);
      console.log(`  ${pc.dim(`Run ${pc.white('codeam pair')} to connect your mobile app.`)}\n`);
    }
    process.exit(0);
  }

  if (!session.agent) {
    throw new Error('Active session has no agent — re-pair with `codeam pair`.');
  }

  // Use the per-session pluginId (set since v1.4.6); fall back to the
  // installation-level pluginId for sessions paired with older CLIs.
  const pluginId = session.pluginId ?? ensurePluginId();

  showInfo(`${session.userName}  ·  ${pc.cyan(session.plan)}`);
  showInfo(`Launching ${AGENT_REGISTRY[session.agent].displayName}...\n`);

  const cwd = process.cwd();

  const runtime = createRuntimeStrategy(session.agent);
  const historySvc = new HistoryService(runtime, pluginId, cwd);

  const keepAliveCtx = {
    inCodespace: process.env.CODESPACES === 'true',
    codespaceName: process.env.CODESPACE_NAME,
  };
  const { apply: setKeepAlive } = buildKeepAlive(keepAliveCtx);

  const outputSvc = new OutputService(
    session.id,
    pluginId,
    (conversationId) => historySvc.setCurrentConversationId(conversationId),
    (reset) => historySvc.setRateLimitReset(reset),
    () => {
      // Refresh the quota cache when stale (30 min TTL) and ship the
      // delta of the just-finished turn so the SSE consumers can
      // fetch the canonical markdown via `?last=1` and replace the
      // streamed PTY approximation with proper ``` fences / blocks.
      if (historySvc.isQuotaStale()) fetchQuotaUsage(runtime, historySvc);
      setTimeout(() => {
        historySvc.uploadDelta().catch(() => { /* best-effort */ });
      }, 400);
    },
    () => {
      // Terminal-initiated turn — the user typed directly in their
      // local terminal. Wait for Claude Code to flush the user
      // message into the JSONL, then start the relay turn with:
      // clear → user_message → new_turn → response.
      const prevCount = historySvc.getCurrentMessageCount();
      historySvc.waitForNewUserMessage(prevCount)
        .then((userText) => outputSvc.startTerminalTurn(userText ?? undefined))
        .catch(() => outputSvc.startTerminalTurn(undefined));
    },
    session.pluginAuthToken,
    runtime,
  );

  const claude = new AgentService(
    runtime,
    {
      cwd,
      onData(raw) { outputSvc.push(raw); },
      onExit(code) {
        process.removeListener('SIGINT', sigintHandler);
        outputSvc.dispose();
        relay.stop();
        process.exit(code);
      },
    },
  );

  // Built EARLY so the closure inside `relay`'s onCommand below has
  // a stable reference. Filled in once the dependent services exist.
  const ctx: HandlerContext = {
    outputSvc,
    claude,
    historySvc,
    runtime,
    relay: undefined as unknown as CommandRelayService,
    setKeepAlive,
    keepAliveCtx,
  };

  const relay = new CommandRelayService(pluginId, async (cmd) => {
    await dispatchCommand(ctx, cmd);
  }, runtime.meta);
  ctx.relay = relay;

  // Wire the IDE terminal handlers so PTY data + exit events stream
  // back to the IDE client via the same SSE chunk channel chat uses.
  // The handler module keeps its own session map; we just forward
  // the pushes through outputSvc.
  registerTerminalHandlers({
    onData: ({ sessionId, data }) => {
      void outputSvc.sendTerminalChunk(sessionId, data);
    },
    onExit: ({ sessionId, exitCode }) => {
      void outputSvc.sendTerminalExit(sessionId, exitCode);
    },
  });

  function sigintHandler(): void {
    claude.kill();
    outputSvc.dispose();
    relay.stop();
    process.exit(0);
  }

  process.once('SIGINT', sigintHandler);
  // Spawn Claude FIRST so its strategy is set + the PTY is launching
  // before the relay starts dispatching remote commands.
  await claude.spawn();
  // Eagerly activate the output stream BEFORE the relay starts so
  // Claude's startup screen reaches the mobile / landing client. The
  // trust-this-folder dialog (and any other first-run interactive
  // selector) renders within the first second of `claude` boot — if
  // the OutputService is still inactive, those bytes get dropped at
  // `pty-buffer.push()` and the user is stranded looking at a blank
  // chat with no way to acknowledge the dialog. Calling
  // `startTerminalTurn` here is the same code path used when the
  // human types directly in the local terminal: emits `clear` +
  // `new_turn`, activates the buffer, and tick() picks up the
  // selector that's already on screen.
  await outputSvc.startTerminalTurn();
  relay.start();

  // After Claude is up, load the local history index so the
  // /sessions surface (list of past conversations) is ready to
  // serve. We deliberately DO NOT auto-detect + upload "the most
  // recently modified JSONL" here: on a freshly paired CLI in a
  // directory that already has prior Claude history, that would
  // publish a stale conversation as the session's "active" one
  // and the mobile / web chat would render an old conversation
  // as if it were the new session's content. `uploadDelta()`
  // lazy-detects when Claude actually writes a turn (real
  // interaction), so the conversation id gets set the right way
  // — only after the user has engaged with the session, never
  // because a leftover JSONL happens to exist on disk.
  setTimeout(() => {
    historySvc.load().catch(() => {});
  }, 2000);
  setTimeout(() => fetchQuotaUsage(runtime, historySvc), 5000);
}

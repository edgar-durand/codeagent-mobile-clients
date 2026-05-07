import pc from 'picocolors';
import { getActiveSession, ensurePluginId } from '../config';
import { showIntro, showInfo } from '../ui/banner';
import { CommandRelayService } from '../services/command-relay.service';
import { ClaudeService } from '../services/claude.service';
import { OutputService } from '../services/output.service';
import { HistoryService } from '../services/history.service';
import { fetchQuotaUsage } from './start/quota-fetcher';
import { buildKeepAlive } from './start/keep-alive';
import { dispatchCommand, type HandlerContext } from './start/handlers';

/**
 * Wires the long-running services (PTY ↔ output relay ↔ command
 * dispatch ↔ history) into a paired-session run-loop. Every piece
 * of behaviour beyond wiring lives in a sibling module under
 * `start/` so this file stays a readable orchestrator.
 */
export async function start(): Promise<void> {
  showIntro();

  const session = getActiveSession();
  if (!session) {
    console.log(`  ${pc.dim('No paired session found.')}`);
    console.log(`  ${pc.dim(`Run ${pc.white('codeam pair')} to connect your mobile app.`)}\n`);
    process.exit(0);
  }

  // Use the per-session pluginId (set since v1.4.6); fall back to the
  // installation-level pluginId for sessions paired with older CLIs.
  const pluginId = session.pluginId ?? ensurePluginId();

  showInfo(`${session.userName}  ·  ${pc.cyan(session.plan)}`);
  showInfo('Launching Claude Code...\n');

  const cwd = process.cwd();

  const historySvc = new HistoryService(pluginId, cwd);

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
      if (historySvc.isQuotaStale()) fetchQuotaUsage(historySvc);
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
  );

  const claude = new ClaudeService({
    cwd,
    onData(raw) { outputSvc.push(raw); },
    onExit(code) {
      process.removeListener('SIGINT', sigintHandler);
      outputSvc.dispose();
      relay.stop();
      process.exit(code);
    },
  });

  // Built EARLY so the closure inside `relay`'s onCommand below has
  // a stable reference. Filled in once the dependent services exist.
  const ctx: HandlerContext = {
    outputSvc,
    claude,
    historySvc,
    relay: undefined as unknown as CommandRelayService,
    setKeepAlive,
    keepAliveCtx,
  };

  const relay = new CommandRelayService(pluginId, async (cmd) => {
    await dispatchCommand(ctx, cmd);
  });
  ctx.relay = relay;

  function sigintHandler(): void {
    claude.kill();
    outputSvc.dispose();
    relay.stop();
    process.exit(0);
  }

  process.once('SIGINT', sigintHandler);
  relay.start();
  await claude.spawn();

  // After Claude is up, give the JSONL a moment to settle, then
  // detect the active conversation + push it into the local history
  // cache so /usage and /context surfaces work immediately.
  setTimeout(() => {
    historySvc.detectCurrentConversation();
    historySvc.load().catch(() => {});
    const currentId = historySvc.getCurrentConversationId();
    if (currentId) {
      historySvc.loadConversation(currentId).catch(() => {});
    }
  }, 2000);
  setTimeout(() => fetchQuotaUsage(historySvc), 5000);
}

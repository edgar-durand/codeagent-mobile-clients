import { ClaudeService } from '../services/claude.service';
import { OutputService } from '../services/output.service';
import { HistoryService } from '../services/history.service';
import { CommandRelayService, type RemoteCommand } from '../services/command-relay.service';
import { dispatchCommand, type HandlerContext } from './start/handlers';
import { fetchQuotaUsage } from './start/quota-fetcher';
import { buildKeepAlive } from './start/keep-alive';

/**
 * `codeam plugin-bridge` — single-session embed mode for IDE plugins.
 *
 * Mirrors `start()` byte-for-byte EXCEPT for the command source: where
 * the standalone CLI polls / streams `/api/commands/pending`, the
 * bridge reads newline-delimited `RemoteCommand` JSON objects from
 * stdin. The plugin host (JetBrains / VS Code) is the polling client;
 * it forwards the commands it gets for Claude Code to this subprocess
 * via `process.stdin.write(JSON.stringify(cmd) + '\n')`.
 *
 * Critically, the bridge does NOT claim a new PairedSession. It uses
 * the plugin's existing `sessionId + pluginId + pluginAuthToken`
 * (passed via env to keep them out of `ps -ef`) so the chunks it pushes
 * to `/api/commands/output` land on the plugin's own session in mobile.
 * The user sees one session — the same one they had before — but the
 * Claude Code path now goes through the CLI's PTY parser (chunks,
 * selectors, thinking panels, pricing, history sync, etc.).
 *
 * Lifecycle: on SIGINT / stdin EOF the bridge kills the Claude PTY,
 * disposes the output stream, and exits cleanly. The plugin owns the
 * subprocess handle and re-spawns on demand.
 */
export async function pluginBridge(): Promise<void> {
  const sessionId = process.env.CODEAM_BRIDGE_SESSION_ID;
  const pluginId = process.env.CODEAM_BRIDGE_PLUGIN_ID;
  const pluginAuthToken = process.env.CODEAM_BRIDGE_PLUGIN_AUTH_TOKEN;

  if (!sessionId || !pluginId || !pluginAuthToken) {
    // eslint-disable-next-line no-console
    console.error(
      '[plugin-bridge] missing CODEAM_BRIDGE_SESSION_ID / CODEAM_BRIDGE_PLUGIN_ID / CODEAM_BRIDGE_PLUGIN_AUTH_TOKEN env',
    );
    process.exit(1);
  }

  const cwd = process.cwd();
  const historySvc = new HistoryService(pluginId, cwd);

  // Bridge always runs locally — never inside a Codespace — so the
  // keep-alive heartbeat (which targets the codespace stop API) is
  // a no-op here. Same builder as `start.ts`, just an empty context.
  const keepAliveCtx = { inCodespace: false, codespaceName: undefined };
  const { apply: setKeepAlive } = buildKeepAlive(keepAliveCtx);

  const outputSvc = new OutputService(
    sessionId,
    pluginId,
    (conversationId) => historySvc.setCurrentConversationId(conversationId),
    (reset) => historySvc.setRateLimitReset(reset),
    () => {
      if (historySvc.isQuotaStale()) fetchQuotaUsage(historySvc);
      setTimeout(() => {
        historySvc.uploadDelta().catch(() => { /* best-effort */ });
      }, 400);
    },
    () => {
      // The bridge has no local TTY; the only way bytes reach the
      // PTY is via stdin commands from the plugin host. Mirroring
      // start.ts so any direct-typing future use-case still works.
      const prevCount = historySvc.getCurrentMessageCount();
      historySvc.waitForNewUserMessage(prevCount)
        .then((userText) => outputSvc.startTerminalTurn(userText ?? undefined))
        .catch(() => outputSvc.startTerminalTurn(undefined));
    },
    pluginAuthToken,
  );

  const claude = new ClaudeService({
    cwd,
    onData(raw) { outputSvc.push(raw); },
    onExit(code) {
      outputSvc.dispose();
      process.exit(code);
    },
  });

  // The `relay` only exists to satisfy `HandlerContext`; handlers call
  // `relay.sendResult` to ack commands, which still goes through the
  // backend HTTP endpoint. We never `relay.start()` (that would open
  // an SSE stream and we'd be receiving commands from two sources).
  const relayStub = new CommandRelayService(pluginId, async () => { /* never invoked */ });

  const ctx: HandlerContext = {
    outputSvc,
    claude,
    historySvc,
    relay: relayStub,
    setKeepAlive,
    keepAliveCtx,
  };

  function shutdown(code: number): void {
    try { claude.kill(); } catch { /* ignore */ }
    try { outputSvc.dispose(); } catch { /* ignore */ }
    process.exit(code);
  }
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));

  // Spawn Claude FIRST so its PTY strategy is set + the prompt
  // boundary marker arrives before any stdin command lands.
  await claude.spawn();
  await outputSvc.startTerminalTurn();

  // Stdin command stream: newline-delimited JSON. Each line parses
  // into a `RemoteCommand` and goes through the same dispatcher
  // start.ts uses for HTTP-polled commands. Malformed lines are
  // dropped so a misbehaving caller can't crash the bridge.
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const raw = JSON.parse(line) as Partial<RemoteCommand>;
        if (typeof raw?.id !== 'string' || typeof raw?.type !== 'string') continue;
        const cmd: RemoteCommand = {
          id: raw.id,
          type: raw.type,
          sessionId, // always the plugin's session — ignore any value from the host
          payload: (raw.payload ?? {}) as Record<string, unknown>,
        };
        dispatchCommand(ctx, cmd).catch(() => { /* swallow per-command failures */ });
      } catch {
        /* malformed line — drop */
      }
    }
  });
  process.stdin.on('end', () => shutdown(0));

  // Same post-spawn warm-up as start.ts: wait for the JSONL to settle,
  // detect active conversation, prime the local cache so /usage and
  // /context are responsive immediately, then prime the quota usage.
  setTimeout(() => {
    historySvc.detectCurrentConversation();
    historySvc.load().catch(() => {});
    const currentId = historySvc.getCurrentConversationId();
    if (currentId) historySvc.loadConversation(currentId).catch(() => {});
  }, 2000);
  setTimeout(() => fetchQuotaUsage(historySvc), 5000);
}

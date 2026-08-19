import { randomUUID } from 'node:crypto';
import type { CommandRelayService, RemoteCommand } from '../services/command-relay.service';
import type { RuntimeStrategy } from '../agents/strategy';
import { HistoryService } from '../services/history.service';
import { TurnFileAggregator } from '../services/turn-files/turn-file-aggregator';
import type { AcpClient } from '../agents/acp/client';
import type { AcpPublisher } from '../agents/acp/publisher';
import { createBudgetRecovery } from '../agents/acp/budgetRecovery';
import type { PromptBlock } from '../agents/acp/buildAcpPromptBlocks';
import { relaunchProxyWithoutBudget } from '../agents/acp/headroom-budget-proxy';
import { AcpHistory, StreamingState, type AcpRunnerOptions } from '../agents/acp/runner';
import {
  assembleAcpCommandContext,
  dispatchAcpCommand,
  type AcpSessionContext,
} from '../agents/acp/command-handlers';
import { log } from '../services/logger';
import type { DriverKind, SessionDriver } from './types';

export interface AcpDriverDeps {
  /** The live ACP client — spawned lazily by {@link AcpDriver.start}. Shared
   *  with `wire-baton`, which wires its `onSessionUpdate` into {@link streaming}. */
  client: AcpClient;
  /** Backend fan-out (chat pipe, streaming-chunk feed, session list). */
  publisher: AcpPublisher;
  /** Per-turn accumulator; wire-baton points the client's `onSessionUpdate` at it. */
  streaming: StreamingState;
  /** Interactive strategy for the agent — supplies `listModels()` + the history
   *  parser the on-disk JSONL uploader uses. */
  runtime: RuntimeStrategy;
  /** Ring of recent adapter stderr lines — used by the failure classifiers. */
  recentStderr: string[];
  /** ACP-runner-shaped options assembled from the baton session options. */
  opts: AcpRunnerOptions;
  /** Late-bound relay accessor: the single {@link CommandRelayService} is created
   *  AFTER the drivers in `wire-baton`, so we read it lazily at dispatch time. */
  getRelay: () => CommandRelayService;
}

/**
 * Drives the conversation over ACP via the existing {@link AcpClient}. On resume
 * it spawns the adapter then `loadSession(id)` (proven to continue a
 * natively-created session).
 *
 * Beyond lifecycle, this driver OWNS the ACP command machinery: it builds the
 * same {@link AcpSessionContext} `runAcpSession` builds (models, on-disk JSONL
 * history, the conversation-history accumulator, the turn-file aggregator, the
 * Headroom budget-recovery) and routes each relayed command through
 * {@link dispatchAcpCommand}. The session context is built lazily on the first
 * command and rebuilt on every {@link start} (a fresh/resumed conversation), so
 * `start`/`stop`/`whenSafeToYield` stay cheap for a driver that never dispatches.
 * `dispatch` brackets each turn with {@link beginTurn}/{@link endTurn} so a
 * hand-off (`whenSafeToYield`) never interrupts a live turn.
 */
export class AcpDriver implements SessionDriver {
  readonly kind: DriverKind = 'mobile_acp';
  private turnActive = false;
  private waiters: Array<() => void> = [];

  /** Set once the adapter has handshaked (in {@link start}); the shared
   *  conversation id (resumed id, or the freshly minted one). */
  private acpSessionId: string | null = null;
  private agentCaps: { loadSession?: boolean } | undefined;
  /** Lazily-built, memoised per {@link start} — cleared when the conversation
   *  changes so history/models rebind to the current conversation. */
  private session: AcpSessionContext | null = null;
  private budgetReachedPosted = false;

  constructor(private readonly deps: AcpDriverDeps) {}

  async start(resumeId?: string): Promise<string> {
    // ⚠️ ZERO-TURN GUARD (2026-08-18 incident). The native TUI hands us the id
    // it PRE-MINTED at spawn (claude `--session-id <uuid>`), but the agent only
    // writes `<id>.jsonl` on its FIRST turn. A user who pairs and immediately
    // takes control from mobile — without typing anything in the terminal —
    // therefore hands us an id that exists NOWHERE on disk, and
    // `claude-agent-acp`'s `session/load` for it never resolves (observed live:
    // no `← ok`, no error, ever) → the baton wedged in `SWITCHING` forever.
    // There is no conversation to preserve in that case, so we start FRESH and
    // adopt the ACP-minted id as THE conversation id: mobile drives it, the
    // controller stores it, and the later handback `--resume`s the very
    // conversation mobile just drove (the ACP adapter writes to the same
    // on-disk store the native TUI resumes from).
    const resumable = resumeId !== undefined && this.hasTranscript(resumeId);
    if (resumeId !== undefined && !resumable) {
      log.info(
        'batonAcp',
        `resume id ${resumeId.slice(0, 8)} has no transcript on disk (zero turns yet) — starting a fresh ACP session instead of session/load`,
      );
    }
    let started: Awaited<ReturnType<AcpClient['start']>>;
    try {
      started = await this.deps.client.start();
      if (resumable && resumeId !== undefined) {
        // Cross-store bridge (cursor): its native-TUI conversation lives in a
        // DIFFERENT on-disk store than ACP `session/load` reads, so mirror it
        // across BEFORE the load or `session/load` 404s. No-op for claude/kimi
        // (shared store) and any agent that doesn't implement the hook.
        await this.deps.runtime.syncTranscriptForAcpResume?.(this.deps.opts.cwd, resumeId);
        // `session/load` streams the ENTIRE prior conversation back as
        // session/update notifications before it resolves (ACP spec). Those
        // flow into the shared StreamingState via wire-baton's onSessionUpdate
        // and would open a streaming tail that never closes — pinning mobile's
        // "Thinking…" indicator after Take Control. Mobile already has this
        // history (pushConversation), so swallow the replay for the load only.
        this.deps.streaming.beginLoadReplay();
        try {
          await this.deps.client.loadSession(resumeId);
        } finally {
          this.deps.streaming.endLoadReplay();
        }
      }
    } catch (err) {
      // `loadSession` can throw AFTER `client.start()` already succeeded —
      // the adapter is alive and the client considers itself started. Stop
      // it so a retried take-control (BatonController reverts to
      // LOCAL_DRIVE on this throw) spawns a fresh adapter on the next
      // `start()` instead of failing again for an unrelated reason.
      // Best-effort: never let teardown mask the real error.
      await this.deps.client.stop().catch(() => undefined);
      throw err;
    }
    // Explicit undefined check (not truthiness): an empty-string id must still
    // resume rather than mint a fresh conversation. A NON-resumable resume id
    // (zero turns on disk, above) falls through to the freshly-minted ACP id.
    const conversationId = resumable && resumeId !== undefined ? resumeId : started.sessionId;
    this.acpSessionId = conversationId;
    this.agentCaps = started.initialize.agentCapabilities;
    // New (re)spawn → drop the memoised session so history/models rebind to the
    // now-current conversation id.
    this.session = null;
    this.budgetReachedPosted = false;
    return conversationId;
  }

  /**
   * Does the agent's own on-disk transcript for `conversationId` exist yet?
   * `resolveHistoryFile` returns null when the file isn't there (every baton
   * runtime `existsSync`-checks), which is exactly "the native TUI has run zero
   * turns on this id" — the only case where `session/load` has nothing to load.
   * A runtime without the hook can't be a baton runtime (see `gate.ts`), but if
   * one ever is, assume resumable so behaviour is unchanged.
   */
  private hasTranscript(conversationId: string): boolean {
    const resolve = this.deps.runtime.resolveHistoryFile;
    if (typeof resolve !== 'function') return true;
    try {
      return resolve.call(this.deps.runtime, this.deps.opts.cwd, conversationId) !== null;
    } catch {
      // A throwing resolver must not block a hand-off — fall back to the
      // previous behaviour (attempt the load; it is now bounded by a timeout).
      return true;
    }
  }

  async stop(): Promise<void> {
    await this.deps.client.stop();
    // Clean invariant: a stopped driver holds no conversation/session state,
    // so a stray dispatch() after stop() (or before the next start()) fails
    // the defensive `acpSessionId === null` check above rather than reusing
    // stale state from the previous conversation.
    this.acpSessionId = null;
    this.session = null;
  }

  async dispatch(cmd: RemoteCommand): Promise<void> {
    const relay = this.deps.getRelay();
    const acpSessionId = this.acpSessionId;
    if (acpSessionId === null) {
      // Not holding the baton yet — the router only forwards to the active
      // driver, which is active only after start(), so this is defensive. Ack
      // so mobile never hangs on an unanswered command.
      await relay.sendResult(cmd.id, 'failed', { code: 'BATON_MOBILE_NOT_STARTED' });
      return;
    }
    const session = await this.ensureSession(relay, acpSessionId, this.agentCaps);
    // Bracket the turn so `whenSafeToYield` blocks a hand-off until this
    // dispatched command has fully settled (matches the ACP runner's per-turn
    // discipline). Some commands aren't turns (list_models, get_conversation),
    // but bracketing them is harmless — they resolve immediately.
    this.beginTurn();
    try {
      await dispatchAcpCommand(assembleAcpCommandContext(session, cmd));
    } finally {
      this.endTurn();
    }
  }

  /** Build (once per conversation) the session-scoped ACP context — the same
   *  shape `runAcpSession` assembles. Memoised on {@link session}. */
  private async ensureSession(
    relay: CommandRelayService,
    acpSessionId: string,
    agentCaps: { loadSession?: boolean } | undefined,
  ): Promise<AcpSessionContext> {
    if (this.session) return this.session;
    const { opts, publisher, streaming, runtime, recentStderr } = this.deps;

    // On-disk transcript uploader (get_conversation heals a truncated live turn)
    // — ACP agents write the same `<acpSessionId>.jsonl` the legacy path parses.
    const jsonlHistory = new HistoryService(runtime, opts.pluginId, opts.cwd, {
      pluginAuthToken: opts.pluginAuthToken,
    });
    // Conversation-history accumulator (RECENT list + resume anchor).
    const history = new AcpHistory(publisher, { agent: opts.agent, acpSessionId });
    // End-of-turn file changeset producer (PENDING REVIEW counter + Files rail).
    const turnFiles = new TurnFileAggregator({
      workingDir: opts.cwd,
      sessionId: opts.sessionId,
      pluginId: opts.pluginId,
      pluginAuthToken: opts.pluginAuthToken,
      agentId: opts.agent,
    });
    const budgetReachedFlag = {
      get: () => this.budgetReachedPosted,
      set: (v: boolean) => {
        this.budgetReachedPosted = v;
      },
    };
    const budgetRecovery = createBudgetRecovery<PromptBlock>({
      publishText: (text) => publisher.publishOutput({ type: 'text', content: text, done: true }),
      publishSelectPrompt: (question, options) =>
        publisher.publishOutput({
          type: 'select_prompt',
          content: question,
          options,
          optionDescriptions: options.map(() => ''),
          currentIndex: 0,
          done: true,
        }),
      publishAwaitingAnswer: (prompt, options) =>
        publisher.publishAwaitingAnswer({ questionId: randomUUID(), prompt, options }),
      publishRawChunk: (chunk) => publisher.publishOutput(chunk),
      sendResult: (commandId, status, result) => relay.sendResult(commandId, status, result),
      appendAgentReply: (text) => history.appendAgentReply(text),
      flushHistory: () => void history.flush(),
      relaunchProxyWithoutBudget,
      agentId: opts.agent,
    });

    this.session = {
      client: this.deps.client,
      relay,
      acpSessionId,
      streaming,
      opts,
      history,
      jsonlHistory,
      agentCaps,
      turnFiles,
      getBeads: opts.getBeads ?? (() => null),
      publisher,
      recentStderr,
      budgetRecovery,
      budgetReachedFlag,
    };
    return this.session;
  }

  beginTurn(): void {
    this.turnActive = true;
  }

  endTurn(): void {
    this.turnActive = false;
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve());
  }

  whenSafeToYield(): Promise<void> {
    if (!this.turnActive) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

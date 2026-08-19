import type { AgentService } from '../services/agent.service';
import type { CommandRelayService, RemoteCommand } from '../services/command-relay.service';
import type { RuntimeStrategy } from '../agents/strategy';
import { OutputService } from '../services/output.service';
import { HistoryService } from '../services/history.service';
import { buildKeepAlive, type KeepAliveContext } from '../commands/start/keep-alive';
import { dispatchCommand, type PtyHandlerContext } from '../commands/start/handlers';
import type { StartedBeads } from '../beads';
import type { DriverKind, SessionDriver } from './types';
import { parkTerminalForReadonly } from './terminal';

export interface NativeTuiDriverDeps {
  /** The native-TUI PTY wrapper. wire-baton forwards each PTY data chunk to
   *  {@link NativeTuiDriver.handlePtyData} so the idle boundary detector works
   *  AND mobile-routed turns stream back through the output pipe. */
  agent: AgentService;
  /** Interactive strategy for the agent (drives the PTY + history parsing). */
  runtime: RuntimeStrategy;
  /** Session identity + credentials the PTY command handlers read. */
  opts: {
    sessionId: string;
    pluginId: string;
    agentId: string;
    pluginAuthToken?: string;
    cwd: string;
  };
  /** Late-bound relay accessor — the single relay is created after the drivers. */
  getRelay: () => CommandRelayService;
  /** Live Beads handle (null when beads is off). */
  getBeads: () => StartedBeads | null;
  /** Quiet PTY window (ms) that counts as a turn boundary. Default 750. */
  idleMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Late-bind callback for agents that mint their session id only on the FIRST
   * TURN (Codex), not at spawn. `start()` returns null for them so `begin()`
   * never blocks/crashes; a background poll then calls this with the real id the
   * moment the user's first turn creates the transcript, so the controller can
   * bind the conversation + arm the mirror. Undefined for the common case.
   */
  onLateBind?: (conversationId: string) => void;
}

/**
 * Drives the native agent TUI in a PTY via the existing {@link AgentService}.
 * The caller MUST forward each PTY data chunk to {@link handlePtyData} so the
 * idle-based turn-boundary detector works.
 *
 * Beyond lifecycle, this driver OWNS the PTY command machinery: an
 * {@link OutputService} (streams a mobile-routed turn's reply back to the app),
 * a {@link HistoryService} (conversation upload), and a no-op keep-alive (the
 * baton is local-only, so codespace keep-alive never applies). {@link dispatch}
 * routes each relayed command through the legacy {@link dispatchCommand} with a
 * {@link PtyHandlerContext} — so after mobile hands the baton back, a prompt from
 * the app is typed into the local TUI and its reply streams to mobile.
 *
 * Turn-boundary safety for hand-off is idle-based ({@link whenSafeToYield}) — a
 * PTY turn has no clean programmatic end — so `dispatch` does NOT bracket turns.
 */
export class NativeTuiDriver implements SessionDriver {
  readonly kind: DriverKind = 'local_tui';
  private readonly agent: AgentService;
  private readonly idleMs: number;
  private readonly now: () => number;
  private lastOutput: number;

  /** How long `start()` waits for a boot-time session store (Kimi) before
   *  falling back to background/late-bind discovery (Codex, first-turn store). */
  private static readonly QUICK_DISCOVER_MS = 8_000;

  private readonly outputSvc: OutputService;
  private readonly historySvc: HistoryService;
  private readonly setKeepAlive: (enabled: boolean) => void;
  private readonly keepAliveCtx: KeepAliveContext;

  constructor(private readonly deps: NativeTuiDriverDeps) {
    this.agent = deps.agent;
    this.idleMs = deps.idleMs ?? 750;
    this.now = deps.now ?? Date.now;
    // Seed to "now" rather than 0 — an epoch of 0 would make the very
    // first whenSafeToYield() call see a bogus multi-decade quiet
    // window and resolve instantly, before any real output has settled.
    this.lastOutput = this.now();

    this.historySvc = new HistoryService(deps.runtime, deps.opts.pluginId, deps.opts.cwd, {
      pluginAuthToken: deps.opts.pluginAuthToken,
    });
    // Output pipe for mobile-routed turns. We deliberately DON'T wire the
    // terminal-turn auto-detector here: in LOCAL_DRIVE the read-only
    // TranscriptMirror already mirrors human-typed turns, so the output pipe
    // only activates on an explicit `newTurn()` from a mobile-routed command.
    this.outputSvc = new OutputService(
      deps.opts.sessionId,
      deps.opts.pluginId,
      (conversationId) => this.historySvc.setCurrentConversationId(conversationId),
      (reset) => this.historySvc.setRateLimitReset(reset),
      undefined,
      undefined,
      deps.opts.pluginAuthToken,
      deps.runtime,
    );
    // ⚠️ LOCAL_DRIVE mirrors the TRANSCRIPT, never the screen. Every PTY byte
    // of the native TUI used to flow through this OutputService and get
    // published as chat output, so mobile rendered raw Claude Code chrome
    // (box-drawing rules, `❯`, "auto mode on (shift+tab to cycle) · esc to
    // interrupt") as if it were the agent talking. The read-only
    // TranscriptMirror is the ONLY source of chat content while this driver
    // holds the baton (the ACP driver streams typed content in MOBILE_DRIVE),
    // so the publish path stays muted for this driver's whole life — `push()`
    // still runs, keeping the session-id / rate-limit detection side-effects.
    this.outputSvc.setPublishSuppressed(true);
    // Baton is local-only → keep-alive is a no-op (codespace-only mechanism).
    this.keepAliveCtx = { inCodespace: false, codespaceName: undefined };
    this.setKeepAlive = buildKeepAlive(this.keepAliveCtx).apply;
  }

  async start(resumeId?: string): Promise<string | null> {
    // Explicit undefined check (not truthiness): the contract is "fresh when
    // undefined, else resume" — an empty-string id must still resume, not spawn fresh.
    if (resumeId !== undefined) {
      // Cross-store bridge (cursor): mirror whatever mobile did over ACP back
      // into the native-TUI store BEFORE relaunching `--resume`, so the terminal
      // picks up the mobile turns. No-op for claude/kimi (shared store) and any
      // agent that doesn't implement the hook.
      await this.deps.runtime.syncTranscriptForNativeResume?.(this.deps.opts.cwd, resumeId);
      await this.agent.restart(resumeId, false);
      return resumeId;
    }
    // Stamp BEFORE spawn so an agent that mints its id on-disk at boot (Kimi)
    // can distinguish the session it just created from stale ones for this cwd.
    const spawnedAt = this.now();
    await this.agent.spawn();
    // Fast path: the runtime pre-minted the id (Claude's `--session-id`) →
    // AgentService already knows it, no discovery needed.
    const preMinted = this.agent.spawnedSessionId;
    if (preMinted) return preMinted;
    // Fallback: some agents neither pre-mint nor print the id — they only WRITE
    // it to their on-disk session store. If the runtime knows how to find it
    // (Kimi/Codex `discoverSessionId`), poll for it. Inert for other agents.
    const discover = this.deps.runtime.discoverSessionId;
    if (!discover) {
      throw new Error('NativeTuiDriver: agent did not expose a session id after spawn');
    }
    // Quick probe: agents that write their store at BOOT (Kimi, ~2 s) resolve
    // here, so the baton binds immediately with no behaviour change.
    const quick = await discover(this.deps.opts.cwd, {
      sinceMs: spawnedAt,
      timeoutMs: NativeTuiDriver.QUICK_DISCOVER_MS,
    });
    if (quick) return quick;
    // Deferred: agents that mint their id only on the FIRST TURN (Codex) have no
    // store yet. Blocking here would freeze `begin()` until the user types (or
    // crash on timeout), so instead return null (the baton comes up in
    // LOCAL_DRIVE with a pending conversation) and keep discovering in the
    // BACKGROUND — the native TUI is interactive, so the user's first turn
    // creates the transcript and we late-bind the id then.
    void discover(this.deps.opts.cwd, { sinceMs: spawnedAt })
      .then((id) => {
        if (id) this.deps.onLateBind?.(id);
      })
      .catch(() => {
        /* best-effort — a failed background poll just leaves take-control off */
      });
    return null;
  }

  async stop(): Promise<void> {
    this.agent.kill();
    // Hand-off (not process exit): the native TUI was hard-killed, so the
    // terminal modes it turned on (focus reporting, bracketed paste, mouse)
    // are still latched — a cooked-mode tty would echo each focus event as
    // `^[[I^[[O`. Reset them + park stdin for the read-only MOBILE_DRIVE view.
    parkTerminalForReadonly();
  }

  async dispatch(cmd: RemoteCommand): Promise<void> {
    const ctx: PtyHandlerContext = {
      outputSvc: this.outputSvc,
      agent: this.agent,
      historySvc: this.historySvc,
      runtime: this.deps.runtime,
      relay: this.deps.getRelay(),
      setKeepAlive: this.setKeepAlive,
      keepAliveCtx: this.keepAliveCtx,
      pluginId: this.deps.opts.pluginId,
      sessionId: this.deps.opts.sessionId,
      agentId: this.deps.opts.agentId,
      pluginAuthToken: this.deps.opts.pluginAuthToken,
      beads: this.deps.getBeads(),
    };
    await dispatchCommand(ctx, cmd);
  }

  /** Call on every PTY data chunk: reset the idle timer AND feed the output
   *  pipe so a mobile-routed turn's reply streams back to the app. */
  handlePtyData(raw: string): void {
    this.noteOutput();
    this.outputSvc.push(raw);
  }

  /** Reset the idle timer only. Retained for callers that just need the boundary
   *  clock nudged without routing bytes through the output pipe. */
  noteOutput(): void {
    this.lastOutput = this.now();
  }

  whenSafeToYield(): Promise<void> {
    return new Promise<void>((resolve) => {
      const tick = () => {
        const quietFor = this.now() - this.lastOutput;
        if (quietFor >= this.idleMs) resolve();
        else setTimeout(tick, this.idleMs - quietFor);
      };
      tick();
    });
  }
}

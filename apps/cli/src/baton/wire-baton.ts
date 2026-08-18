import type { AgentId, NormalizedMessage } from '@codeam/shared';
import type { McpServer } from '@agentclientprotocol/sdk';
import { CommandRelayService, type RemoteCommand } from '../services/command-relay.service';
import { AgentService } from '../services/agent.service';
import { createRuntimeStrategy } from '../agents/registry';
import { AcpClient } from '../agents/acp/client';
import type { AdapterSpec } from '../agents/acp/adapters';
import { AcpPublisher } from '../agents/acp/publisher';
import { StreamingState, type AcpRunnerOptions } from '../agents/acp/runner';
import { mapSessionUpdate, mapPermissionRequest } from '../agents/acp/mappers';
import { fetchCurrentPluginAuthToken, postBatonEvent } from '../services/pairing.service';
import { showInfo, showSuccess, showRelayNotice } from '../ui/banner';
import { log } from '../services/logger';
import type { StartedBeads } from '../beads';
import { BatonController } from './baton-controller';
import { NativeTuiDriver } from './native-tui-driver';
import { AcpDriver } from './acp-driver';
import { TranscriptMirror } from './transcript-mirror';
import type { BatonState, DriverKind } from './types';

/**
 * Command router for a baton session. The two baton-control commands
 * (`take_control` / `handback`) drive the {@link BatonController} directly;
 * every other command is forwarded to the currently-active driver's
 * dispatcher (`dispatchActive`). Extracted as a pure function so the routing
 * is unit-testable without spinning up any real driver, PTY, or ACP adapter.
 */
export function makeOnCommand(deps: {
  controller: Pick<BatonController, 'takeControl' | 'handback' | 'state'>;
  dispatchActive: (cmd: RemoteCommand) => Promise<void>;
  ack: (id: string, status: string, result: unknown) => Promise<void>;
}) {
  return async function onCommand(cmd: RemoteCommand): Promise<void> {
    if (cmd.type === 'take_control') {
      try {
        await deps.controller.takeControl();
      } catch (err) {
        await deps.ack(cmd.id, 'failed', {
          code: 'BATON_SWITCH_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      await deps.ack(cmd.id, 'completed', { state: deps.controller.state });
      return;
    }
    if (cmd.type === 'handback') {
      try {
        await deps.controller.handback();
      } catch (err) {
        await deps.ack(cmd.id, 'failed', {
          code: 'BATON_SWITCH_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      await deps.ack(cmd.id, 'completed', { state: deps.controller.state });
      return;
    }
    await deps.dispatchActive(cmd);
  };
}

/**
 * Test seam over {@link makeOnCommand}: builds the same `onCommand` with a
 * no-op `ack`, so a unit test can prove the routing (baton-control →
 * controller, everything else → active-driver dispatcher) without a relay.
 */
export const buildBaton = {
  forTest(deps: {
    controller: Pick<BatonController, 'takeControl' | 'handback' | 'state'>;
    dispatchActive: (c: RemoteCommand) => Promise<void>;
  }) {
    return {
      onCommand: makeOnCommand({
        controller: deps.controller,
        dispatchActive: deps.dispatchActive,
        ack: async () => {},
      }),
    };
  },
};

/**
 * Publisher surface {@link makeMirrorOnNewMessages} needs — a subset of
 * {@link AcpPublisher} so tests can pass a fake without constructing a real
 * one (no HTTP, no plugin-auth token).
 */
export interface MirrorLivePublisher {
  publishOutput: (body: Record<string, unknown>) => Promise<void>;
  pushConversation: (args: {
    agentId: AgentId;
    sessionId: string;
    messages: Array<{ id: string; role: 'user' | 'agent'; text: string; timestamp: number }>;
  }) => Promise<void>;
}

/**
 * Replay one already-completed turn from the transcript mirror over the
 * SAME live chat-output pipe (`/api/commands/output`) an ACP/legacy-PTY turn
 * uses, so an open mobile renders it as it happens instead of only after a
 * leave+re-open (which loads from the `pushConversation` snapshot). Matches
 * `OutputService.startTerminalTurn`'s locally-typed-turn shape exactly:
 * a user message opens with `clear` → `user_message` → `new_turn`; the
 * agent's reply — already complete by the time the mirror sees it (no
 * per-token deltas available from a JSONL tail) — closes with one final
 * `text` chunk carrying `done: true`.
 */
async function publishMirroredTurnsLive(
  publisher: Pick<MirrorLivePublisher, 'publishOutput'>,
  messages: NormalizedMessage[],
): Promise<void> {
  for (const m of messages) {
    if (m.role === 'user') {
      await publisher.publishOutput({ type: 'clear' });
      await publisher.publishOutput({ type: 'user_message', content: m.text, done: true });
      await publisher.publishOutput({ type: 'new_turn', done: false });
    } else {
      await publisher.publishOutput({ type: 'text', content: m.text, done: true });
    }
  }
}

/**
 * Builds the {@link TranscriptMirror} `onNewMessages` handler used while
 * LOCAL_DRIVE holds the baton. The mirror emits only the DELTA appended
 * since its last read, so this factory accumulates the full message list
 * and always pushes the COMPLETE current conversation to the
 * `pushConversation` snapshot (the mobile's cold-open / reconnect history
 * source). ⚠️ Pushing the delta with `mode:'replace'` (the previous bug)
 * left the stored snapshot holding only the last turn, so re-opening the
 * session showed a truncated history. In ADDITION, each qualifying batch is
 * replayed turn-by-turn over the live output pipe via
 * {@link publishMirroredTurnsLive}, so a mobile client that already has the
 * session open sees each new local turn as it lands.
 *
 * ⚠️ FRESH vs RE-ARM decides whether the FIRST emit live-publishes:
 * {@link TranscriptMirror} starts its internal `emitted` counter at 0, so
 * the first `onNewMessages` call after `start()` reports everything the file
 * currently holds as "new".
 *  - `fresh: true` — the mirror was started by `controller.begin()` (the very
 *    first LOCAL_DRIVE). The mobile has NOTHING yet, so EVERY turn including
 *    the first must live-publish, or a mobile watching a brand-new local
 *    session would see no bubbles until a leave+re-open.
 *  - `fresh: false` — the mirror was RE-ARMED after a handback
 *    (MOBILE_DRIVE → LOCAL_DRIVE). The mobile already rendered the whole
 *    conversation during MOBILE_DRIVE, so the first emit is a pure catch-up
 *    read (the entire file to date) and MUST NOT be replayed over the live
 *    pipe — that would duplicate every past bubble. Only turns genuinely
 *    added during this local drive live-publish.
 *
 * The snapshot is pushed on EVERY emit in both modes (it's idempotent —
 * `mode:'replace'` on the full list), so reconnect/cold-open always reflects
 * the complete conversation regardless of fresh/re-arm.
 *
 * Batches are drained through a private promise chain so two `onNewMessages`
 * calls in quick succession (rapid file-watch events) can't interleave
 * their HTTP posts out of order (`clear`/`user_message`/`new_turn` must
 * land before the following turn's `text done:true`).
 *
 * Extracted as a pure factory (mirrors {@link makeOnCommand}) so it's
 * testable with a fake publisher, without a real TranscriptMirror/PTY.
 */
export function makeMirrorOnNewMessages(deps: {
  publisher: MirrorLivePublisher;
  agentId: AgentId;
  conversationId: string;
  /** True when started by `begin()` (fresh local session, mobile has nothing
   *  → live-publish from the first turn); false on a handback re-arm (mobile
   *  already has the history → skip the first catch-up emit's live replay). */
  fresh: boolean;
}): (messages: NormalizedMessage[]) => void {
  let isFirstEmit = true;
  let publishChain: Promise<void> = Promise.resolve();
  // Full running conversation the mirror has seen, so the snapshot is always
  // the COMPLETE history (the mirror only ever hands us the newest delta).
  const conversation: Array<{
    id: string;
    role: 'user' | 'agent';
    text: string;
    timestamp: number;
  }> = [];
  return (messages: NormalizedMessage[]): void => {
    const relevant = messages.filter((m) => m.role !== 'system');
    if (relevant.length === 0) return;
    const mapped = relevant.map((m) => ({
      id: m.id,
      role: (m.role === 'user' ? 'user' : 'agent') as 'user' | 'agent',
      text: m.text,
      timestamp: toEpochMs(m.timestamp),
    }));
    conversation.push(...mapped);
    void deps.publisher.pushConversation({
      agentId: deps.agentId,
      sessionId: deps.conversationId,
      messages: conversation.slice(),
    });
    // Live-publish every batch EXCEPT a re-arm's first (catch-up) read.
    if (deps.fresh || !isFirstEmit) {
      publishChain = publishChain
        .then(() => publishMirroredTurnsLive(deps.publisher, relevant))
        .catch((err) => {
          log.warn(
            'wireBaton',
            `mirror live-publish failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
    isFirstEmit = false;
  };
}

/**
 * Serialize baton driver-state POSTs so a FAST switch can't let the steady
 * state overtake the transient `SWITCHING` event on the wire.
 *
 * `BatonController` publishes `SWITCHING` and then the steady state
 * (`LOCAL_DRIVE`/`MOBILE_DRIVE`) back-to-back. On a fast hand-back the native
 * TUI respawns almost instantly, so both POSTs would leave nearly together and,
 * being independent requests (potentially served by different Cloud Run
 * instances), could be fanned out to the mobile in either order — leaving the
 * app latched on "Switching…" forever. The backend publishes each event on the
 * per-user SSE bus AND writes the Redis snapshot BEFORE it responds 2xx, so
 * awaiting each POST before issuing the next guarantees ordered delivery.
 *
 * Overall behaviour stays fire-and-forget (the returned function is `void`);
 * only the ORDER between successive posts is enforced. Each post is
 * independently non-fatal — a failure never breaks the chain (`postBatonEvent`
 * already resolves on error, and we swallow anything else defensively).
 */
export function makeSerializedBatonPoster<A>(
  post: (args: A) => Promise<unknown>,
): (args: A) => void {
  let chain: Promise<void> = Promise.resolve();
  return (args: A): void => {
    chain = chain.then(() => post(args)).then(
      () => undefined,
      () => undefined,
    );
    void chain;
  };
}

/**
 * How often the baton re-affirms its current state to the backend. Well under
 * the backend's 1 h `baton:<sessionId>` Redis TTL (`TTL_BATON_STATUS = 3600`)
 * so the snapshot is refreshed with a very wide margin, and far rarer than the
 * 20 s heartbeat it rides so we don't spam the SSE bus.
 */
export const BATON_REAFFIRM_INTERVAL_MS = 5 * 60_000;

/**
 * Builds the heartbeat rider that keeps the backend's baton snapshot alive.
 *
 * ⚠️ THE BUG THIS FIXES: the CLI only ever posted `baton_state` on a state
 * TRANSITION. The backend mirrors each post into Redis `baton:<sessionId>`
 * with a **1 h TTL**, and mobile does ONE `GET /api/baton/sessions/:id/state`
 * on session open, treating `null` as "pre-baton CLI" (no BatonBar — a
 * deliberate rollout-safety default). So a local session left alone for over
 * an hour lost its snapshot and re-opened with the Take-Control affordance
 * GONE, even though the CLI was alive and holding the baton. The source of
 * truth has to keep RE-AFFIRMING, not just announce edges.
 *
 * It rides the relay's EXISTING 20 s heartbeat tick (`onHeartbeat`) rather
 * than arming a timer of its own — CLAUDE.md "No polling for realtime" plus
 * "Heartbeat must stay punctual": one timer, and the rider only hands the
 * already-known state to the serialized poster (a fire-and-forget POST), so
 * the tick does no synchronous work.
 *
 * Rules:
 *  - **Throttled** to {@link BATON_REAFFIRM_INTERVAL_MS} — the point is
 *    keeping a 1 h TTL alive, not beating every 20 s.
 *  - **Always re-affirms on the first beat after a (re)connect**, so a relay
 *    that just re-established its channel (or just started) republishes
 *    immediately instead of waiting out the throttle.
 *  - **Never re-affirms the transient `SWITCHING` state** — the controller
 *    publishes the steady state moments later through the same serialized
 *    poster; re-asserting a stale `SWITCHING` is the one thing that could
 *    latch mobile on "Switching…". The throttle clock is left untouched in
 *    that case so the very next tick re-affirms the steady state.
 *  - **No-op when the baton isn't active** (`currentState()` → `null`, e.g.
 *    after teardown) — non-baton sessions never construct this at all.
 */
export function makeBatonHeartbeatReaffirm(deps: {
  /** Current baton state, or `null` when there is nothing to affirm. */
  currentState: () => {
    state: BatonState;
    driver: DriverKind;
    conversationId: string | null;
  } | null;
  /** The SAME serialized poster `publishState` uses, so a re-affirm can never
   *  overtake a real transition on the wire. */
  publish: (state: BatonState, driver: DriverKind, conversationId: string | null) => void;
  intervalMs?: number;
  now?: () => number;
}): (info: { firstAfterConnect: boolean }) => void {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? BATON_REAFFIRM_INTERVAL_MS;
  let lastAffirmedAt: number | null = null;
  return ({ firstAfterConnect }): void => {
    const current = deps.currentState();
    if (!current) return;
    if (current.state === 'SWITCHING') return;
    const at = now();
    if (!firstAfterConnect && lastAffirmedAt !== null && at - lastAffirmedAt < intervalMs) return;
    lastAffirmedAt = at;
    deps.publish(current.state, current.driver, current.conversationId);
  };
}

export interface BatonSessionOptions {
  agent: AgentId;
  /** The paired-session id (the backend row). */
  sessionId: string;
  pluginId: string;
  /** Per-pairing secret — `X-Plugin-Auth-Token` on every authed POST. */
  pluginAuthToken: string;
  /** Replayed to the gated `/api/pairing/reconnect` for token refresh. */
  pollSecret?: string;
  cwd: string;
  /** ACP adapter spec resolved from {@link getAcpAdapter} for the MOBILE driver. */
  adapter: AdapterSpec;
  /** Accessor for the live Beads handle, provisioned by the composition root
   *  (`start()`); null until it resolves or forever when beads is off. */
  getBeads?: () => StartedBeads | null;
  /** Agent Toolkits integration MCP servers to advertise on the MOBILE
   *  driver's ACP session — the same list `start.ts` threads into the plain
   *  ACP path, built once by {@link buildMcpServersForStart}. */
  mcpServers?: McpServer[];
}

/**
 * Composition root for a LOCAL session baton (local-only — the caller in
 * `start.ts` guards on `isLocalSession()`).
 *
 * Assembles the real pieces and blocks forever (mirroring `runAcpSession`):
 *   - a {@link NativeTuiDriver} over the existing {@link AgentService} PTY —
 *     the LOCAL driver (`begin()` spawns the agent's native TUI);
 *   - an {@link AcpDriver} over a real {@link AcpClient} wired to stream to
 *     mobile (`onSessionUpdate` → {@link StreamingState}) — the MOBILE driver;
 *   - a {@link BatonController} whose `publishState` posts to the backend via
 *     {@link postBatonEvent} so mobile can render the Take-Control state;
 *   - a {@link TranscriptMirror} that tails the agent's JSONL during
 *     LOCAL_DRIVE and pushes the read-only conversation over the existing
 *     `pushConversation` transport;
 *   - a {@link CommandRelayService} whose `onCommand` is {@link makeOnCommand}
 *     (baton-control → controller; everything else → the active driver).
 *
 * The baton is DRIVABLE: after a hand-off, every non-baton command is routed to
 * whichever driver holds the baton via `controller.activeSessionDriver.dispatch`
 * — the {@link AcpDriver} runs it through `dispatchAcpCommand` (MOBILE_DRIVE),
 * the {@link NativeTuiDriver} through the legacy PTY `dispatchCommand`
 * (LOCAL_DRIVE). Each driver owns the command machinery its side needs and acks
 * over the relay, so mobile never hangs on an unanswered command.
 */
export async function runBatonSession(opts: BatonSessionOptions): Promise<void> {
  const publisher = new AcpPublisher({
    sessionId: opts.sessionId,
    pluginId: opts.pluginId,
    pluginAuthToken: opts.pluginAuthToken,
    refreshAuthToken: () =>
      fetchCurrentPluginAuthToken(opts.sessionId, opts.pluginId, opts.pollSecret),
  });

  // The interactive runtime strategy powers BOTH the native TUI (`AgentService`
  // spawns it) and the transcript mirror (`resolveHistoryFile`/`parseHistoryFile`).
  const runtime = createRuntimeStrategy(opts.agent);

  // ─── MOBILE driver: ACP client streaming to mobile ───────────────────────
  const streaming = new StreamingState(publisher);
  const recentStderr: string[] = [];
  const client = new AcpClient({
    adapter: opts.adapter,
    cwd: opts.cwd,
    mcpServers: opts.mcpServers,
    onSessionUpdate: (notification) => {
      for (const delta of mapSessionUpdate(notification)) streaming.append(delta);
    },
    // Swallow the ACP session/load history replay during the kimi "Session is
    // closed" recovery (AcpClient.reestablishSession) — kimi 0.23.6 replays the
    // whole conversation as session/update, which would otherwise prepend a
    // prior turn's text to the recovered reply on the baton's mobile stream too
    // (same leak the plain ACP runner wires at runner.ts). Same `streaming`
    // instance the baton's own AcpDriver.start bracketing uses.
    beginLoadReplay: () => streaming.beginLoadReplay(),
    endLoadReplay: () => streaming.endLoadReplay(),
    onRequestPermission: async (request) => {
      const { event, optionIdByLabel } = mapPermissionRequest(request);
      await publisher.publishAwaitingAnswer(event);
      return streaming.registerPermission({
        questionId: event.questionId,
        labels: event.options ?? [],
        optionIdByLabel,
      });
    },
    onStderr: (line) => {
      recentStderr.push(line);
      if (recentStderr.length > 40) recentStderr.shift();
    },
    onUnexpectedExit: (code, signal) => {
      log.warn('baton', `ACP adapter exited code=${code} signal=${signal}; flushing`);
      void streaming.closeAll().finally(() => process.exit(code ?? 1));
    },
  });
  // The single relay is created near the end (it needs the controller). Declared
  // here so each driver's `getRelay` closure can reach it — the closures only
  // fire at dispatch time, long after `relay` is assigned.
  let relay: CommandRelayService;
  // ACP-runner-shaped options the AcpDriver reuses to build the exact same
  // command context runAcpSession builds. autoApprovePermissions is omitted:
  // the baton is local, so the human answers permission prompts interactively.
  const acpOpts: AcpRunnerOptions = {
    agent: opts.agent,
    sessionId: opts.sessionId,
    pluginId: opts.pluginId,
    pluginAuthToken: opts.pluginAuthToken,
    adapter: opts.adapter,
    cwd: opts.cwd,
    getBeads: opts.getBeads,
    pollSecret: opts.pollSecret,
    mcpServers: opts.mcpServers,
  };
  const mobileDriver = new AcpDriver({
    client,
    publisher,
    streaming,
    runtime,
    recentStderr,
    opts: acpOpts,
    getRelay: () => relay,
  });

  // ─── LOCAL driver: native TUI over AgentService ──────────────────────────
  // `nativeDriver` is referenced inside `onData` before its assignment below —
  // safe because `onData` only fires once the PTY produces output, well after
  // construction completes.
  let nativeDriver: NativeTuiDriver;
  const agent = new AgentService(runtime, {
    cwd: opts.cwd,
    onData(raw) {
      // Reset the idle boundary clock AND feed the output pipe so a
      // mobile-routed turn (LOCAL_DRIVE dispatch) streams its reply back.
      nativeDriver.handlePtyData(raw);
    },
    onExit(code) {
      teardown();
      process.exit(code);
    },
  });
  nativeDriver = new NativeTuiDriver({
    agent,
    runtime,
    opts: {
      sessionId: opts.sessionId,
      pluginId: opts.pluginId,
      agentId: opts.agent,
      pluginAuthToken: opts.pluginAuthToken,
      cwd: opts.cwd,
    },
    getRelay: () => relay,
    getBeads: opts.getBeads ?? (() => null),
    // Late-bind for first-turn-minted ids (Codex): the background discovery
    // calls this once the user's first terminal turn creates the transcript.
    // Safe forward-ref — `controller` is initialised long before `begin()` runs,
    // and onLateBind only fires from inside `begin()`'s spawn.
    onLateBind: (id: string) => controller.rebindConversation(id),
  });

  // ─── Read-only transcript mirror (rebuilt each LOCAL_DRIVE entry) ─────────
  // Keeps the `pushConversation` snapshot fresh AND live-publishes each new
  // local turn over the chat-output pipe, so an open mobile renders
  // LOCAL_DRIVE turns per-turn instead of only after leave+re-open.
  let mirror: TranscriptMirror | null = null;
  // The FIRST LOCAL_DRIVE is the one `begin()` publishes — a fresh local
  // session the mobile has never seen (live-publish from turn one). Every
  // later LOCAL_DRIVE entry can only be reached via a handback, i.e. a re-arm
  // where the mobile already holds the conversation (skip the catch-up replay).
  let firstLocalDrive = true;
  const startMirror = (conversationId: string, fresh: boolean): void => {
    mirror?.stop();
    mirror = new TranscriptMirror({
      runtime,
      cwd: opts.cwd,
      conversationId,
      onNewMessages: makeMirrorOnNewMessages({
        publisher,
        agentId: opts.agent,
        conversationId,
        fresh,
      }),
    });
    mirror.start();
  };

  // ─── Controller: single active driver + backend state publish ────────────
  // Ordered baton-state poster — successive POSTs never overtake one another.
  const postBatonState = makeSerializedBatonPoster(postBatonEvent);
  // Fire-and-forget, non-fatal — but ORDERED (see makeSerializedBatonPoster):
  // a fast SWITCHING→steady-state pair must not arrive reordered and leave
  // mobile stuck on "Switching…". Shared by the controller's transition
  // publishes AND the heartbeat re-affirmation rider, so both ride ONE chain.
  const publishBatonState = (
    state: BatonState,
    driver: DriverKind,
    conversationId: string | null,
  ): void => {
    postBatonState({
      sessionId: opts.sessionId,
      pluginId: opts.pluginId,
      pluginAuthToken: opts.pluginAuthToken,
      state,
      driver,
      conversationId,
    });
  };
  const controller = new BatonController({
    local: nativeDriver,
    mobile: mobileDriver,
    publishState: (state: BatonState, driver: DriverKind, conversationId: string | null) => {
      publishBatonState(state, driver, conversationId);
      // (Re-)arm the read-only mirror whenever the native TUI holds the baton.
      // The first LOCAL_DRIVE (from `begin()`) is a fresh session; subsequent
      // ones are handback re-arms.
      if (state === 'LOCAL_DRIVE' && conversationId) {
        startMirror(conversationId, firstLocalDrive);
        firstLocalDrive = false;
      } else if (state !== 'LOCAL_DRIVE') {
        mirror?.stop();
      }
    },
  });

  // ─── Relay: baton-control → controller; else → active driver ─────────────
  // Every non-baton command is forwarded to whichever driver holds the baton:
  // the AcpDriver (MOBILE_DRIVE → dispatchAcpCommand) or the NativeTuiDriver
  // (LOCAL_DRIVE → the legacy PTY dispatchCommand). Each driver owns its own
  // command machinery and acks via the relay, so mobile never hangs.
  const dispatchActive = (cmd: RemoteCommand): Promise<void> =>
    controller.activeSessionDriver.dispatch(cmd);
  // Declared here (ahead of the ─── Lifecycle ─── block that sets it) so the
  // heartbeat rider below can read it; the rider only ever runs post-`start()`.
  let torn = false;
  // The relay's heartbeat also carries the baton state RE-AFFIRMATION rider
  // (see makeBatonHeartbeatReaffirm): the backend keeps the baton snapshot in
  // Redis for 1 h, and mobile renders no BatonBar when that snapshot is gone,
  // so a live session that hasn't switched drivers in over an hour would lose
  // Take Control entirely. Riding the existing 20 s tick keeps it to ONE timer.
  relay = new CommandRelayService(
    opts.pluginId,
    makeOnCommand({
      controller,
      dispatchActive,
      ack: (id, status, result) => relay.sendResult(id, status, result),
    }),
    runtime.meta,
    undefined,
    undefined,
    makeBatonHeartbeatReaffirm({
      // Nothing to affirm once the session is torn down.
      currentState: () => (torn ? null : controller.currentState()),
      publish: publishBatonState,
    }),
  );

  // ─── Lifecycle ───────────────────────────────────────────────────────────
  function teardown(): void {
    if (torn) return;
    torn = true;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGHUP', onSignal);
    mirror?.stop();
    relay.stop();
    void controller.shutdown();
  }
  const onSignal = (): void => {
    teardown();
    process.exit(0);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);

  showInfo(`Starting ${opts.agent} baton (local) — native TUI + mobile take-control…`);
  await controller.begin(); // LOCAL_DRIVE: spawns the native TUI, publishes state
  relay.start();
  showSuccess(`${opts.agent} baton online — you're driving locally; mobile can take control.`);
  showRelayNotice();

  // Block forever — the relay runs in the background and the lifecycle hooks
  // above tear everything down on exit (mirrors runAcpSession).
  await new Promise<void>(() => {});
}

/** Best-effort ISO-or-epoch timestamp → epoch ms (NormalizedMessage.timestamp
 *  is a string; the conversation wire shape wants a number). */
function toEpochMs(ts: string): number {
  const asNum = Number(ts);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

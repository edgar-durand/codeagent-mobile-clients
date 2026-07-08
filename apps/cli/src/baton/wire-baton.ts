import type { AgentId } from '@codeam/shared';
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
    onSessionUpdate: (notification) => {
      for (const delta of mapSessionUpdate(notification)) streaming.append(delta);
    },
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
  });

  // ─── Read-only transcript mirror (rebuilt each LOCAL_DRIVE entry) ─────────
  let mirror: TranscriptMirror | null = null;
  const startMirror = (conversationId: string): void => {
    mirror?.stop();
    mirror = new TranscriptMirror({
      runtime,
      cwd: opts.cwd,
      conversationId,
      onNewMessages: (messages) => {
        const mapped = messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            id: m.id,
            role: (m.role === 'user' ? 'user' : 'agent') as 'user' | 'agent',
            text: m.text,
            timestamp: toEpochMs(m.timestamp),
          }));
        if (mapped.length === 0) return;
        void publisher.pushConversation({
          agentId: opts.agent,
          sessionId: conversationId,
          messages: mapped,
        });
      },
    });
    mirror.start();
  };

  // ─── Controller: single active driver + backend state publish ────────────
  const controller = new BatonController({
    local: nativeDriver,
    mobile: mobileDriver,
    publishState: (state: BatonState, driver: DriverKind, conversationId: string | null) => {
      // Fire-and-forget, non-fatal — mirrors postPreviewEvent semantics.
      void postBatonEvent({
        sessionId: opts.sessionId,
        pluginId: opts.pluginId,
        pluginAuthToken: opts.pluginAuthToken,
        state,
        driver,
        conversationId,
      });
      // Re-arm the read-only mirror whenever the native TUI holds the baton.
      if (state === 'LOCAL_DRIVE' && conversationId) startMirror(conversationId);
      else if (state !== 'LOCAL_DRIVE') mirror?.stop();
    },
  });

  // ─── Relay: baton-control → controller; else → active driver ─────────────
  // Every non-baton command is forwarded to whichever driver holds the baton:
  // the AcpDriver (MOBILE_DRIVE → dispatchAcpCommand) or the NativeTuiDriver
  // (LOCAL_DRIVE → the legacy PTY dispatchCommand). Each driver owns its own
  // command machinery and acks via the relay, so mobile never hangs.
  const dispatchActive = (cmd: RemoteCommand): Promise<void> =>
    controller.activeSessionDriver.dispatch(cmd);
  relay = new CommandRelayService(
    opts.pluginId,
    makeOnCommand({
      controller,
      dispatchActive,
      ack: (id, status, result) => relay.sendResult(id, status, result),
    }),
    runtime.meta,
  );

  // ─── Lifecycle ───────────────────────────────────────────────────────────
  let torn = false;
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

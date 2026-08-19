import type { BatonControllerDeps, BatonState, DriverKind, SessionDriver } from './types';

/** Owns exactly one active driver. Transitions are turn-safe (await `whenSafeToYield`)
 *  and serialized: a switch already in progress moves state to `SWITCHING`, so a
 *  further request for the same transition is a no-op (single-driver invariant). */
export class BatonController {
  /**
   * Default upper bound on a whole hand-off. A cold `newSession` on claude is
   * ~20 s, so 45 s leaves generous headroom for a healthy switch while still
   * failing FAST enough that the user gets an honest error instead of a
   * permanent "Switching…".
   */
  static readonly DEFAULT_SWITCH_TIMEOUT_MS = 45_000;

  private _state: BatonState = 'LOCAL_DRIVE';
  private _active: DriverKind = 'local_tui';
  private _conversationId: string | null = null;

  constructor(private readonly deps: BatonControllerDeps) {}

  get state(): BatonState {
    return this._state;
  }

  get activeDriver(): DriverKind {
    return this._active;
  }

  /** The driver object currently holding the baton. The baton router forwards
   *  non-baton commands to `activeSessionDriver.dispatch(cmd)`, so whichever side
   *  holds the baton is the one that actually runs the command. Reads `_active`
   *  live, so mid-turn commands during a `SWITCHING` window still target the
   *  pre-switch driver (the switch waits for the turn boundary before flipping). */
  get activeSessionDriver(): SessionDriver {
    return this._active === 'local_tui' ? this.deps.local : this.deps.mobile;
  }

  get conversationId(): string | null {
    return this._conversationId;
  }

  /** The exact triple the last `publishState` emitted — the CLI's current view
   *  of who holds the baton. Read by the heartbeat re-affirmation rider
   *  ({@link makeBatonHeartbeatReaffirm}), which re-posts it periodically so the
   *  backend's 1 h Redis snapshot never expires under a live session. */
  currentState(): { state: BatonState; driver: DriverKind; conversationId: string | null } {
    return {
      state: this._state,
      driver: this._active,
      conversationId: this._conversationId,
    };
  }

  async begin(): Promise<void> {
    this._conversationId = await this.deps.local.start(undefined);
    this._active = 'local_tui';
    this.setState('LOCAL_DRIVE');
  }

  /**
   * Late-bind the conversation id for an agent (Codex) that minted it only on the
   * user's first turn, so `begin()` returned null. Fires from the native driver's
   * background discovery. Idempotent + guarded: only binds while we're still in
   * the INITIAL, id-less LOCAL_DRIVE — if the user already took control (which
   * started its own session) or an id is already set, it's a no-op, so a stray
   * native id can never clobber the live conversation. Re-publishes LOCAL_DRIVE so
   * the read-only mirror arms on the now-known id.
   */
  rebindConversation(conversationId: string): void {
    if (this._conversationId !== null || this._state !== 'LOCAL_DRIVE') return;
    this._conversationId = conversationId;
    this.setState('LOCAL_DRIVE');
  }

  async takeControl(): Promise<void> {
    await this.switchDriver(
      'LOCAL_DRIVE',
      this.deps.local,
      this.deps.mobile,
      'MOBILE_DRIVE',
      'mobile_acp',
    );
  }

  async handback(): Promise<void> {
    await this.switchDriver(
      'MOBILE_DRIVE',
      this.deps.mobile,
      this.deps.local,
      'LOCAL_DRIVE',
      'local_tui',
    );
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([this.deps.local.stop(), this.deps.mobile.stop()]);
  }

  private async switchDriver(
    from: BatonState,
    current: SessionDriver,
    next: SessionDriver,
    to: BatonState,
    nextKind: DriverKind,
  ): Promise<void> {
    if (this._state !== from) return; // single-driver invariant: only the expected steady state may switch
    this.setState('SWITCHING');
    const priorActive = this._active;
    const priorConversationId = this._conversationId;
    const timeoutMs = this.deps.switchTimeoutMs ?? BatonController.DEFAULT_SWITCH_TIMEOUT_MS;
    // Tracks how far the hand-off got, so the recovery below only revives a
    // driver that was actually stopped (never double-spawns one still running).
    let stoppedCurrent = false;
    const handoff = (async (): Promise<string | null> => {
      await current.whenSafeToYield();
      await current.stop();
      stoppedCurrent = true;
      return next.start(priorConversationId ?? undefined);
    })();
    // The hand-off keeps running behind a timeout; its (later) rejection must
    // never surface as an unhandled rejection and take the process down.
    handoff.catch(() => undefined);
    try {
      // ⚠️ BOUNDED (2026-08-18 incident): a driver that resolves NEITHER way —
      // live case, `claude-agent-acp`'s `session/load` for an id with no
      // transcript — used to leave the baton in `SWITCHING` for the rest of the
      // session: mobile latched on "Switching…", and the `_state !== from`
      // guard above made every later take/handback a silent no-op.
      const conversationId = await withDeadline(
        handoff,
        timeoutMs,
        `BATON_SWITCH_TIMEOUT: ${from} → ${to} hand-off did not complete within ${Math.round(
          timeoutMs / 1000,
        )}s`,
      );
      this._conversationId = conversationId;
      this._active = nextKind;
      this.setState(to);
    } catch (err) {
      await this.recoverFromFailedSwitch(
        current,
        next,
        stoppedCurrent,
        priorConversationId,
        timeoutMs,
      );
      // Recover to the pre-switch steady state so the baton is never wedged
      // in 'SWITCHING' — a stuck state would no-op every future take/handback
      // via the `_state !== from` guard above. Published, so mobile leaves
      // "Switching…" too; the caller's ack carries the honest error message.
      this._active = priorActive;
      this.setState(from);
      throw err;
    }
  }

  /**
   * Undo a half-done hand-off. The `next` driver may still be starting behind
   * the deadline — stop it so a second adapter/PTY can't race the revived one.
   * And when `current` was ALREADY stopped before the failure, reverting only
   * the STATE would leave the user staring at a dead terminal (or mobile at a
   * dead adapter), so bring it back on the same conversation. Both best-effort
   * and bounded: recovery must never itself hang the controller.
   */
  private async recoverFromFailedSwitch(
    current: SessionDriver,
    next: SessionDriver,
    stoppedCurrent: boolean,
    priorConversationId: string | null,
    timeoutMs: number,
  ): Promise<void> {
    this._conversationId = priorConversationId;
    await withDeadline(next.stop(), timeoutMs, 'BATON_RECOVERY_STOP_TIMEOUT').catch(
      () => undefined,
    );
    if (!stoppedCurrent) return;
    try {
      const revived = await withDeadline(
        current.start(priorConversationId ?? undefined),
        timeoutMs,
        'BATON_RECOVERY_START_TIMEOUT',
      );
      // A revived driver may mint a new conversation id (nothing to resume).
      if (revived) this._conversationId = revived;
    } catch {
      // Best-effort: the state still reverts, so the user can retry.
    }
  }

  private setState(state: BatonState): void {
    this._state = state;
    this.deps.publishState(state, this._active, this._conversationId);
  }
}

/**
 * Resolve `promise`, or reject with `message` after `ms`. The timer is always
 * cleared, so a settled race never keeps the event loop alive.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

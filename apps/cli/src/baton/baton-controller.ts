import type { BatonControllerDeps, BatonState, DriverKind, SessionDriver } from './types';

/** Owns exactly one active driver. Transitions are turn-safe (await `whenSafeToYield`)
 *  and serialized: a switch already in progress moves state to `SWITCHING`, so a
 *  further request for the same transition is a no-op (single-driver invariant). */
export class BatonController {
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
    try {
      await current.whenSafeToYield();
      await current.stop();
      this._conversationId = await next.start(this._conversationId ?? undefined);
      this._active = nextKind;
      this.setState(to);
    } catch (err) {
      // Recover to the pre-switch steady state so the baton is never wedged
      // in 'SWITCHING' — a stuck state would no-op every future take/handback
      // via the `_state !== from` guard above.
      this._active = priorActive;
      this._conversationId = priorConversationId;
      this.setState(from);
      throw err;
    }
  }

  private setState(state: BatonState): void {
    this._state = state;
    this.deps.publishState(state, this._active, this._conversationId);
  }
}

import type { RemoteCommand } from '../services/command-relay.service';

/** Which driver is holding the baton. */
export type DriverKind = 'local_tui' | 'mobile_acp';

/** LOCAL_DRIVE / MOBILE_DRIVE = steady states; SWITCHING = a handoff is in flight. */
export type BatonState = 'LOCAL_DRIVE' | 'MOBILE_DRIVE' | 'SWITCHING';

/** A driver runs one side of a session (native TUI or mobile ACP). */
export interface SessionDriver {
  readonly kind: DriverKind;
  /** Fresh session when `resumeId` is undefined; resumes that conversation otherwise.
   *  Resolves with the conversation id (the resumed id, or a freshly minted one). */
  start(resumeId?: string): Promise<string>;
  stop(): Promise<void>;
  /** Resolves at the next turn boundary — safe to stop this driver without losing output. */
  whenSafeToYield(): Promise<void>;
  /** Execute a non-baton relay command (send_prompt, start_task, select_option, …)
   *  against THIS driver's live session — the ACP command pipeline for the mobile
   *  driver, the legacy PTY command pipeline for the native-TUI driver. The baton
   *  router forwards every command that is not `take_control` / `handback` here, so
   *  after a hand-off the taker actually drives. */
  dispatch(cmd: RemoteCommand): Promise<void>;
}

export interface BatonControllerDeps {
  local: SessionDriver;
  mobile: SessionDriver;
  publishState: (state: BatonState, driver: DriverKind, conversationId: string | null) => void;
}

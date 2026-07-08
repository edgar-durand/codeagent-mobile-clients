import type { AgentService } from '../services/agent.service';
import type { DriverKind, SessionDriver } from './types';

export type AgentServiceLike = Pick<
  AgentService,
  'spawn' | 'restart' | 'kill' | 'spawnedSessionId'
>;

export interface NativeTuiDriverDeps {
  agent: AgentServiceLike;
  /** Quiet PTY window (ms) that counts as a turn boundary. Default 750. */
  idleMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Drives the native agent TUI in a PTY via the existing AgentService.
 * The caller MUST forward each PTY data chunk to `noteOutput()` so the
 * idle-based turn-boundary detector works.
 */
export class NativeTuiDriver implements SessionDriver {
  readonly kind: DriverKind = 'local_tui';
  private readonly agent: AgentServiceLike;
  private readonly idleMs: number;
  private readonly now: () => number;
  private lastOutput: number;

  constructor(deps: NativeTuiDriverDeps) {
    this.agent = deps.agent;
    this.idleMs = deps.idleMs ?? 750;
    this.now = deps.now ?? Date.now;
    // Seed to "now" rather than 0 — an epoch of 0 would make the very
    // first whenSafeToYield() call see a bogus multi-decade quiet
    // window and resolve instantly, before any real output has settled.
    this.lastOutput = this.now();
  }

  async start(resumeId?: string): Promise<string> {
    // Explicit undefined check (not truthiness): the contract is "fresh when
    // undefined, else resume" — an empty-string id must still resume, not spawn fresh.
    if (resumeId !== undefined) {
      await this.agent.restart(resumeId, false);
      return resumeId;
    }
    await this.agent.spawn();
    const id = this.agent.spawnedSessionId;
    if (!id) throw new Error('NativeTuiDriver: agent did not expose a session id after spawn');
    return id;
  }

  async stop(): Promise<void> {
    this.agent.kill();
  }

  /** Call on every PTY data chunk to reset the idle timer. */
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

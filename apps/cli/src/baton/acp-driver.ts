import type { AcpClient } from '../agents/acp/client';
import type { DriverKind, SessionDriver } from './types';

// `start` is narrowed to the `{ sessionId }` shape the driver actually reads
// (not `Pick<AcpClient, 'start'>` verbatim) — the real AcpClient.start()
// return type also carries `initialize`/`model`/`tier`, which a fake test
// client has no reason to fabricate. A real AcpClient still satisfies this
// type: its start() return value is a structural superset of `{ sessionId }`.
export type AcpClientLike = Pick<AcpClient, 'loadSession' | 'stop'> & {
  start(): Promise<{ sessionId: string }>;
};

export interface AcpDriverDeps {
  client: AcpClientLike;
}

/**
 * Drives the conversation over ACP via the existing AcpClient. On resume it
 * spawns the adapter then `loadSession(id)` (proven to continue a
 * natively-created session). The relay handler brackets each turn with
 * beginTurn()/endTurn() so hand-off never interrupts a live turn.
 */
export class AcpDriver implements SessionDriver {
  readonly kind: DriverKind = 'mobile_acp';
  private turnActive = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly deps: AcpDriverDeps) {}

  async start(resumeId?: string): Promise<string> {
    const { sessionId } = await this.deps.client.start();
    if (resumeId) {
      await this.deps.client.loadSession(resumeId);
      return resumeId;
    }
    return sessionId;
  }

  async stop(): Promise<void> {
    await this.deps.client.stop();
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

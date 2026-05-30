import { createOsStrategy } from '../../os';

export interface PtyStrategyOptions {
  onData: (data: string) => void;
  onExit: (code: number) => void;
}

export interface IPtyStrategy {
  spawn(cmd: string, cwd: string, args?: string[]): void;
  write(data: string | Buffer): void;
  kill(): void;
  dispose(): void;
  /**
   * PID of the spawned child (typically a helper that exec's the
   * real agent binary). `null` when no process is running or the
   * backend doesn't expose it. Used by HistoryService to ask the
   * OS which JSONL the agent has open — a deterministic
   * alternative to the birthtime heuristic for the case where
   * Claude auto-resumes a pre-boot session.
   */
  pid?: number | null;
}

/**
 * Backward-compat re-export. The canonical home for PATH probing
 * is `OsStrategy.findInPath` (`src/os/strategy.ts`) — adopted by
 * agent strategies via constructor-injection per #50. Until every
 * caller migrates, this helper keeps the existing call sites
 * unchanged by delegating to the platform's OsStrategy.
 *
 * @deprecated Inject an OsStrategy via the agent strategy
 * constructor and call `this.os.findInPath(name)` instead.
 */
export function findInPath(name: string): string | null {
  return createOsStrategy().findInPath(name);
}

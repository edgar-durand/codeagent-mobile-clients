import { createOsStrategy, type OsStrategy } from '../os';

export interface ClaudeLaunch {
  /** Executable to spawn — already an absolute path on Windows. */
  cmd: string;
  /** Args including any wrapper-shell prefix (e.g. `/c <real-cmd>`). */
  args: string[];
}

/**
 * Resolve how to launch Claude Code from the current PATH.
 *
 * This was the original home of the `.cmd / .ps1 / .exe` wrapping
 * logic that ConPTY needs. As of #49 the per-OS launch-wrapping
 * lives on `OsStrategy.buildLaunch` so any agent's strategy can
 * reuse the same primitive; this helper stays as the Claude-specific
 * binary-name probe (`claude` then `claude-code`) and delegates the
 * wrap to the OsStrategy.
 *
 * Will move to `agents/claude/resolver.ts` in #53 — agent-specific
 * code shouldn't live under `services/`. Kept here for now so #49
 * stays a no-behaviour-change refactor.
 */
export function buildClaudeLaunch(
  extraArgs: string[] = [],
  os: OsStrategy = createOsStrategy(),
): ClaudeLaunch | null {
  const found = os.findInPath('claude') ?? os.findInPath('claude-code');
  if (!found) return null;
  return os.buildLaunch(found, extraArgs);
}

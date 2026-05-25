/**
 * Per-pairing "which repos changed since the last flush" tracker.
 *
 * The legacy chokidar watcher fires on every filesystem event under
 * `workingDir`; without this tracker the turn aggregator would spawn
 * `git status` + `git diff --numstat` for EVERY discovered repo on
 * every `done:true`, even when the agent's turn only modified one
 * sub-repo (or nothing at all — chat-only turns).
 *
 * The tracker stores absolute git-root paths in a Set. The watcher
 * calls `markDirty(repoRoot)` once it has resolved the enclosing
 * repo for each file event. The aggregator calls `consume()` at
 * end-of-turn to atomically read-and-clear the set, then only runs
 * `git status` for the repos that survived the intersection with
 * the discovered set.
 *
 * Initial state: callers seed with `markAllDirty(repos)` after
 * discovery so the FIRST turn captures any pre-pair worktree state
 * (the user may have un-committed edits before pairing) without
 * waiting for a fresh filesystem event.
 *
 * No persistence — the dirty set is process-local and cleared on
 * restart. That's intentional: on restart the discovery pass + the
 * `markAllDirty` seed cover the same ground; the goal of the
 * tracker is incremental optimisation within one CLI lifetime, not
 * durability.
 */
export class RepoDirtyTracker {
  private readonly dirty = new Set<string>();

  /** Add a repo root to the dirty set. Idempotent. */
  markDirty(repoRoot: string): void {
    this.dirty.add(repoRoot);
  }

  /** Seed every known repo as dirty — used right after `discoverRepos`
   *  returns so the first end-of-turn flush captures worktree state
   *  that predates the pairing. */
  markAllDirty(repoRoots: ReadonlyArray<{ repoRoot: string }>): void {
    for (const r of repoRoots) this.dirty.add(r.repoRoot);
  }

  /** Snapshot the current dirty set without clearing — useful for
   *  diagnostic logs / tests. */
  peek(): ReadonlySet<string> {
    return new Set(this.dirty);
  }

  /** Atomically read AND clear the dirty set. The aggregator calls
   *  this on each `done:true`; subsequent filesystem events
   *  re-populate it for the next turn. */
  consume(): Set<string> {
    const snapshot = new Set(this.dirty);
    this.dirty.clear();
    return snapshot;
  }

  /** True when the set is non-empty. Cheap pre-flight gate so the
   *  aggregator can early-return on chat-only turns without
   *  touching the dirty set. */
  hasDirty(): boolean {
    return this.dirty.size > 0;
  }
}

/**
 * Next.js build-clobber self-heal.
 *
 * `next dev` and `next build` can't share `.next/`. When a coding agent runs
 * `next build` in the SAME project a preview's `next dev` is serving, the
 * build rewrites `.next/` — dev's CSS is deleted and its chunks are replaced
 * with hashed production names. The live `next dev` process never finds out:
 * its in-memory asset manifest goes stale and it keeps serving HTML that
 * references files which no longer exist. The user sees the page load with
 * text but NO styling, and reloading does not fix it — nothing ever told
 * `next dev` to recompile.
 *
 * `next build` always rewrites `.next/BUILD_ID`; `next dev` never touches
 * it. Watching that one file is therefore a reliable, cheap signal that a
 * build just clobbered the directory the running dev server depends on —
 * the fix is to kill + re-spawn the dev server (the exact path
 * `preview_restart` already uses), so it recompiles fresh into the
 * now-clobbered `.next/`.
 *
 * Scope: Next.js ONLY (see {@link isBuildHealSupported}). Vite / CRA / other
 * frameworks build to their own `dist/`-style output, never shared with
 * their dev server — there is no equivalent collision, so watching for one
 * there would just be a wasted fs.watch handle with nothing to catch.
 */
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger';

const BUILD_MARKER_NAME = 'BUILD_ID';
const DEFAULT_DEBOUNCE_MS = 1_500;
const DEFAULT_MAX_RESTARTS = 3;

/** Only Next.js shares `.next/` between its dev server and its production
 *  build — see the module doc comment above for why the guard stays this
 *  narrow. */
export function isBuildHealSupported(framework: string): boolean {
  return /next/i.test(framework);
}

/**
 * Injectable fs.watch seam (same shape/purpose as `TranscriptMirror`'s
 * `watch` seam in `baton/transcript-mirror.ts`) — tests substitute a fake so
 * events fire deterministically instead of racing real filesystem timing.
 * Returns `null` when the directory can't be watched (permission denied,
 * removed mid-watch, …) rather than throwing — the caller degrades to "no
 * self-heal for this preview" instead of crashing the bring-up.
 */
export type WatchDirFn = (
  dir: string,
  onEvent: (filename: string | null) => void,
) => (() => void) | null;

function defaultWatchDir(
  dir: string,
  onEvent: (filename: string | null) => void,
): (() => void) | null {
  try {
    const w = fs.watch(dir, { persistent: false }, (_eventType, filename) => onEvent(filename));
    return () => w.close();
  } catch {
    return null;
  }
}

/**
 * Per-session count of heal-triggered restarts, kept OUTSIDE any single
 * watcher instance. A heal-triggered restart tears down and re-creates the
 * whole preview (kill devServer → re-spawn → new `ActivePreview` → new
 * watcher — see `maybeAttachBuildHeal` in `commands/start/handlers.ts`), so
 * a counter that lived on the watcher instance would reset to 0 on every
 * cycle and the cap below would never actually stop a genuine rebuild loop.
 * This map is the one piece of state that survives that recreation.
 */
const healRestartCounts = new Map<string, number>();

/**
 * Clears a session's heal-restart count. Callers invoke this when the user
 * genuinely stops the preview (NOT on a heal-triggered restart, which must
 * keep counting against the same cap) so a later fresh preview for the same
 * session starts with a clean slate.
 */
export function resetBuildHealState(sessionId: string): void {
  healRestartCounts.delete(sessionId);
}

export interface BuildHealDeps {
  cwd: string;
  sessionId: string;
  /** Kill + re-spawn the dev server from the SAME stored detection — the
   *  exact path `preview_restart` uses. */
  restart: () => void;
  /** Tell the user what just happened, over the same `preview_progress`
   *  transport the rest of the bring-up pipeline uses. A silent restart
   *  reads as an inexplicable flicker instead of a recovered preview. */
  notify: (message: string) => void;
  watchDir?: WatchDirFn;
  debounceMs?: number;
  maxRestarts?: number;
}

export interface BuildHealWatcher {
  stop: () => void;
}

/**
 * Watches `<cwd>/.next/BUILD_ID` for the lifetime of one preview's dev
 * server and restarts it (debounced, capped) when a build clobbers it.
 *
 * Caller is expected to gate this on {@link isBuildHealSupported} and to
 * call `stop()` from the SAME teardown path that kills the dev server
 * (`killPreview` in `services/preview/index.ts`) so a stopped/replaced
 * preview never leaves an fs.watch handle — or a pending debounce timer —
 * alive. That teardown ordering is also what guarantees a debounced
 * restart never fires for a preview that was stopped in the meantime:
 * `stop()` cancels the pending timer before it can act.
 */
/** Reads the marker's content, or `null` when it doesn't exist (yet). */
function readMarker(markerPath: string): string | null {
  try {
    return fs.readFileSync(markerPath, 'utf8').trim();
  } catch {
    return null;
  }
}

export function watchForBuildClobber(deps: BuildHealDeps): BuildHealWatcher {
  const watchDir = deps.watchDir ?? defaultWatchDir;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxRestarts = deps.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const nextDir = path.join(deps.cwd, '.next');
  const markerPath = path.join(nextDir, BUILD_MARKER_NAME);

  let stopped = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let dirUnwatch: (() => void) | null = null;
  let cwdUnwatch: (() => void) | null = null;
  // Baselined the moment we start watching — NOT at module load. This is
  // what makes a stale/coalesced fs event a no-op instead of a false
  // restart: macOS's FSEvents backend can deliver an event for a write that
  // happened shortly BEFORE `fs.watch` attached (observed live — a
  // directory-level event surfaces from the dev server's own just-finished
  // compile). Comparing actual content, not just "an event fired", is what
  // a real `next build` needs to be distinguished from that backlog AND
  // from any other harmless write under `.next/` that happens to pass the
  // filename filter.
  let lastKnownMarker = readMarker(markerPath);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    dirUnwatch?.();
    dirUnwatch = null;
    cwdUnwatch?.();
    cwdUnwatch = null;
  };

  const onDebouncedClobber = (): void => {
    if (stopped) return;
    const current = readMarker(markerPath);
    if (current === lastKnownMarker) return; // stale/coalesced event — no real change
    lastKnownMarker = current;
    const count = (healRestartCounts.get(deps.sessionId) ?? 0) + 1;
    healRestartCounts.set(deps.sessionId, count);
    if (count > maxRestarts) {
      log.warn(
        'preview',
        `build-heal: restart cap (${maxRestarts}) reached for session=${deps.sessionId} — no longer self-healing`,
      );
      deps.notify(
        'This preview keeps getting rebuilt — stopped auto-restarting. Restart it manually once the rebuilds settle.',
      );
      stop();
      return;
    }
    log.info(
      'preview',
      `build-heal: ${markerPath} changed (a build likely ran) — restarting the dev server (${count}/${maxRestarts})`,
    );
    deps.notify('Rebuilt — restarting preview');
    deps.restart();
  };

  const onMarkerTouched = (): void => {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onDebouncedClobber();
    }, debounceMs);
  };

  const attachDirWatch = (): void => {
    if (dirUnwatch) return;
    lastKnownMarker = readMarker(markerPath);
    dirUnwatch = watchDir(nextDir, (filename) => {
      if (filename === null || filename === BUILD_MARKER_NAME) onMarkerTouched();
    });
  };

  if (fs.existsSync(nextDir)) {
    attachDirWatch();
  } else {
    // `.next/` doesn't exist yet (a fresh project whose dev server hasn't
    // finished its first compile) — watch cwd for its creation, then attach
    // the real watch. Same root-watch fallback idiom as
    // `watchConversationSwitch` (`agents/claude/history.ts`).
    cwdUnwatch = watchDir(deps.cwd, (filename) => {
      if (stopped || dirUnwatch) return;
      if ((filename === '.next' || filename === null) && fs.existsSync(nextDir)) {
        cwdUnwatch?.();
        cwdUnwatch = null;
        attachDirWatch();
      }
    });
  }

  return { stop };
}

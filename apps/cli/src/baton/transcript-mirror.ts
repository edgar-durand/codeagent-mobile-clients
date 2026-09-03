import * as fs from 'fs';
import type { NormalizedMessage } from '@codeam/shared';
import type { RuntimeStrategy } from '../agents/strategy';

export interface TranscriptMirrorDeps {
  runtime: Pick<RuntimeStrategy, 'resolveHistoryFile' | 'parseHistoryFile'>;
  cwd: string;
  conversationId: string;
  /**
   * @param messages the delta appended since the last emit.
   * @param meta.preexisting TRUE only for the single emit produced when the
   *   transcript ALREADY had content at `start()` — i.e. this batch is history
   *   the mirror is catching up on, not something that just happened. The
   *   handler needs this to decide whether the batch may be replayed as LIVE
   *   turns; see `makeMirrorOnNewMessages`.
   */
  onNewMessages: (messages: NormalizedMessage[], meta: { preexisting: boolean }) => void;
  watch?: (file: string, onChange: () => void) => () => void;
  /** Startup poll cadence while waiting for the agent to create its JSONL
   *  (default 750 ms). Injectable so tests drive it deterministically. */
  pollIntervalMs?: number;
  /** Upper bound on how long `start()` waits for the file to appear before
   *  giving up (default 10 min; 0 = wait forever). Injectable for tests. */
  waitTimeoutMs?: number;
  /** Timer seam so tests can substitute fakes without touching globals. */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

/** Tails the agent's own transcript JSONL and emits only messages appended
 *  since the last emit. Reuses the runtime's history parser (no screen-scrape).
 *
 *  ⚠️ The native TUI creates `~/.claude/projects/<encoded-cwd>/<id>.jsonl` only
 *  on its FIRST turn, so at LOCAL_DRIVE begin the file (and often its parent
 *  dir) does not exist yet — `resolveHistoryFile` returns null. A previous
 *  version bailed out permanently there, so a local conversation NEVER mirrored
 *  to mobile. `start()` instead attaches immediately if the file is already
 *  present, otherwise runs a BOUNDED startup poll of `resolveHistoryFile` and
 *  attaches (emit + watch) the moment the file appears, then stops polling.
 *
 *  This is NOT a realtime-state poll (which the repo forbids — those must ride
 *  an existing event stream): it is a one-shot startup wait for a file whose
 *  parent directory may not yet exist, so there is no fs event to subscribe to.
 *  Once attached, all realtime tailing rides `fs.watch` — never a poll. */
export class TranscriptMirror {
  private emitted = 0;
  private unwatch: (() => void) | null = null;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private attached = false;
  /** True while `start()`'s own synchronous attach attempt is running, so
   *  `tryAttach` can tell "the file was already there" from "it appeared while
   *  we waited". The distinction is the whole basis for whether the first
   *  batch is history or live content. */
  private attachingAtStart = false;

  private readonly pollIntervalMs: number;
  private readonly waitTimeoutMs: number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;

  constructor(private readonly deps: TranscriptMirrorDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 750;
    this.waitTimeoutMs = deps.waitTimeoutMs ?? 10 * 60_000;
    this.setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = deps.clearInterval ?? ((handle) => clearInterval(handle));
  }

  start(): void {
    this.attachingAtStart = true;
    try {
      if (this.tryAttach()) return; // file already present — attach now
    } finally {
      this.attachingAtStart = false;
    }
    // File not yet created (the native TUI writes it on its first turn). Poll
    // for it, bounded by waitTimeoutMs, and attach the instant it appears.
    let waited = 0;
    this.pollHandle = this.setIntervalFn(() => {
      waited += this.pollIntervalMs;
      if (this.tryAttach()) {
        this.clearPoll();
        return;
      }
      if (this.waitTimeoutMs > 0 && waited >= this.waitTimeoutMs) this.clearPoll();
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.clearPoll();
    this.unwatch?.();
    this.unwatch = null;
  }

  /** Resolve the transcript file; if present, emit the current contents and
   *  begin watching. Returns whether it attached. */
  private tryAttach(): boolean {
    if (this.attached) return true;
    const file = this.deps.runtime.resolveHistoryFile?.(this.deps.cwd, this.deps.conversationId);
    if (!file) return false;
    this.attached = true;
    // Anything the file holds at THIS moment is pre-existing history only when
    // the file was already there as `start()` ran. If we attached from the
    // startup poll, the agent created it after we began watching, so its
    // contents are turns that genuinely just happened.
    this.emit(file, this.attachingAtStart);
    const watch = this.deps.watch ?? defaultWatch;
    this.unwatch = watch(file, () => this.emit(file));
    return true;
  }

  private clearPoll(): void {
    if (this.pollHandle !== null) {
      this.clearIntervalFn(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private emit(file: string, preexisting = false): void {
    let all: NormalizedMessage[];
    try {
      all = this.deps.runtime.parseHistoryFile(file);
    } catch {
      return;
    }
    if (all.length <= this.emitted) return;
    const delta = all.slice(this.emitted);
    this.emitted = all.length;
    this.deps.onNewMessages(delta, { preexisting });
  }
}

function defaultWatch(file: string, onChange: () => void): () => void {
  const w = fs.watch(file, { persistent: false }, () => onChange());
  return () => w.close();
}
